// Measures how far drawn content moves on a simulator recording, for `pnpm ios:behavior`.
// Usage: ios-screen-motion <video> <from s> <to s> <x> <y> <width> <height> <screen width>
// [<ignore from x> <ignore to x>], all lengths in points. Each native frame in the window is
// compared with a key frame: the rect is cut into horizontal strips, and for every vertical shift
// of up to 400 points (the probe's teleport threshold, which covers bigger jumps) the tool counts
// the changed strips that the shift brings back to the key frame's content. A scroll moves every
// strip by the same amount, so the right shift brings back most of them; repeated wording fits
// one strip at a time, and a strip that gained text fits no shift. The key frame is replaced
// every 250 ms, carrying the offset measured at that moment, so streaming text barely changes it
// while slow drift of a point at a time still adds up. A frame where most content strips changed
// and no vertical shift explains them (content redrawn in place, or moved sideways) counts as
// unexplained instead of still. Prints one JSON object: frames read, strips with content, the
// largest distance from the starting position with its time, and the unexplained frames with the
// first one's time. The ignored columns hold floating controls that move by design, like the
// jump-to-latest button.
// The view tree and the DEBUG probe report layout passes that never reach the screen (#192232);
// this reads what was drawn.
import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count == 9 || args.count == 11,
      let from = Double(args[2]), let to = Double(args[3]),
      let rectX = Double(args[4]), let rectY = Double(args[5]),
      let rectW = Double(args[6]), let rectH = Double(args[7]),
      let screenWidth = Double(args[8])
else {
    FileHandle.standardError.write(Data(
        "usage: ios-screen-motion <video> <from> <to> <x> <y> <w> <h> <screen width> [<ignore from x> <ignore to x>]\n".utf8))
    exit(2)
}
let ignored = args.count == 11 ? (Double(args[9]) ?? 0)..<(Double(args[10]) ?? 0) : 0..<0

let stripPt = 40
let maxShift = 400
/// Mean absolute luma difference below which a strip is unchanged (video compression noise).
let noise: Float = 2.5
/// A shift must cut the difference to this fraction of the unshifted one to count as a move.
let moveRatio: Float = 0.5

let width = Int(rectW)
let height = Int(rectH)
/// Every other column of the rect, minus the ignored ones.
let columns = stride(from: 0, to: width, by: 2).filter { !ignored.contains(rectX + Double($0)) }

let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
guard let track = asset.tracks(withMediaType: .video).first,
      let reader = try? AVAssetReader(asset: asset)
else {
    FileHandle.standardError.write(Data("cannot read \(args[1])\n".utf8))
    exit(1)
}
let output = AVAssetReaderTrackOutput(
    track: track,
    outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
reader.timeRange = CMTimeRange(
    start: CMTime(seconds: from, preferredTimescale: 600),
    end: CMTime(seconds: to, preferredTimescale: 600))
reader.add(output)
reader.startReading()

/// Luma of the rect on a one-point grid: each point averages its block of pixels.
func lumaGrid(_ buffer: CVPixelBuffer) -> [Float] {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let scale = Double(CVPixelBufferGetWidth(buffer)) / screenWidth
    let block = max(1, Int(scale.rounded()))
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    let pixels = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    let maxX = CVPixelBufferGetWidth(buffer) - block
    let maxY = CVPixelBufferGetHeight(buffer) - block
    var grid = [Float](repeating: 0, count: width * height)
    for gy in 0..<height {
        let py = min(maxY, Int((rectY + Double(gy)) * scale))
        for gx in 0..<width {
            let px = min(maxX, Int((rectX + Double(gx)) * scale))
            var sum = 0
            for dy in 0..<block {
                let row = pixels + (py + dy) * rowBytes + px * 4
                for dx in 0..<block {
                    let p = row + dx * 4
                    sum += 29 * Int(p[0]) + 150 * Int(p[1]) + 77 * Int(p[2])
                }
            }
            grid[gy * width + gx] = Float(sum) / Float(256 * block * block)
        }
    }
    return grid
}

/// Mean absolute difference between rows `top..<top+stripPt` of `a` and the rows `shift` below in `b`.
func difference(_ a: [Float], _ b: [Float], top: Int, shift: Int) -> Float {
    var sum: Float = 0
    for y in top..<(top + stripPt) {
        for x in columns {
            sum += abs(a[y * width + x] - b[(y + shift) * width + x])
        }
    }
    return sum / Float(stripPt * columns.count)
}

/// How long a key frame stays the reference before the current frame replaces it.
let keyFrameSeconds = 0.25

/// Strips with content: plain background matches every shift, so it cannot show motion.
func contentStrips(_ grid: [Float]) -> [Int] {
    // The content test compares each row with the one below, so the last strip leaves one row.
    stride(from: 0, through: height - stripPt - 1, by: stripPt).filter { top in
        difference(grid, grid, top: top, shift: 1) > 2
    }
}

/// The shift most changed strips agree on (0 when fewer than two, or a third of them, agree), and
/// whether most content strips changed with no shift to explain it.
func bestShift(_ key: [Float], _ grid: [Float], strips: [Int]) -> (shift: Int, unexplained: Bool) {
    let changed = strips.compactMap { top -> (top: Int, still: Float)? in
        let still = difference(key, grid, top: top, shift: 0)
        return still >= noise ? (top, still) : nil
    }
    guard changed.count >= 2 else { return (0, false) }
    var best = 0
    var bestCount = 1
    for shift in -maxShift...maxShift where shift != 0 {
        let count = changed.filter { strip in
            strip.top + shift >= 0 && strip.top + shift + stripPt <= height
                && difference(key, grid, top: strip.top, shift: shift) < strip.still * moveRatio
        }.count
        // A tie keeps the smaller shift.
        if count > bestCount || (count == bestCount && best != 0 && abs(shift) < abs(best)) {
            bestCount = count
            best = shift
        }
    }
    if bestCount * 3 >= changed.count {
        return (best, false)
    }
    return (0, changed.count * 2 > strips.count)
}

var key: (grid: [Float], strips: [Int], offset: Int, time: Double)?
var maxStrips = 0
var frames = 0
var largest = 0
var largestAt = from
var unexplained = 0
var unexplainedAt: Double?
while let sample = output.copyNextSampleBuffer() {
    guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
    let grid = lumaGrid(buffer)
    let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
    frames += 1
    var offset = 0
    if let key {
        let measured = bestShift(key.grid, grid, strips: key.strips)
        offset = key.offset + measured.shift
        if measured.unexplained {
            unexplained += 1
            unexplainedAt = unexplainedAt ?? time
        }
        if abs(offset) > largest {
            largest = abs(offset)
            largestAt = time
        }
    }
    if key == nil || time - key!.time >= keyFrameSeconds {
        let strips = contentStrips(grid)
        maxStrips = max(maxStrips, strips.count)
        key = (grid, strips, offset, time)
    }
}
let result: [String: Any] = [
    "frames": frames, "strips": maxStrips, "maxMovePt": largest, "atSec": largestAt,
    "unexplainedFrames": unexplained, "unexplainedAtSec": unexplainedAt ?? NSNull(),
]
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result))
FileHandle.standardOutput.write(Data([0x0A]))
