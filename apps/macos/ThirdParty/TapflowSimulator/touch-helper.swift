// touch-helper.swift
// Injects touch events into iOS Simulator via SimDeviceLegacyHIDClient (SimulatorKit)
//
// Usage: touch-helper <udid|booted>
//
// Stdin protocol: variable-length frames
//   Types 1–5,9: 9 bytes  — [type:u8][a:u8/f32BE][b:f32BE]
//   Types 6–8  : 17 bytes — [type:u8][x1:f32BE][y1:f32BE][x2:f32BE][y2:f32BE]
//
//   type 1 = touch start   (x, y normalized 0–1)
//   type 2 = touch move    (x, y)
//   type 3 = touch end     (x, y unused — last saved coords used)
//   type 4 = HID button    (a=usagePage u32BE, b=usage u32BE)
//   type 5 = legacy button (a=code u32BE)
//   type 6 = pinch start   (x1,y1 = finger0, x2,y2 = finger1, normalized 0–1)
//   type 7 = pinch move    (x1,y1, x2,y2)
//   type 8 = pinch end     (coords unused — last saved coords used)
//   type 9 = key press     ([0]=modifierBitmap u8, [1–3]=pad, [4–7]=hidUsage u32BE, page=0x07)
//   type 10 = HID button down (a=usagePage u32BE, b=usage u32BE) — real-time hold, no auto-up
//   type 11 = HID button up   (a=usagePage u32BE, b=usage u32BE)
//   type 13 = touch cancel    (x, y unused — last saved coords; an up where the touch cannot be cancelled)
//
// Single-touch: IndigoHIDMessageForMouseNSEvent(p, delta=0, target=0x32, NSEventType, size, edge)
// Two-finger:   IndigoHIDMessageForMouseNSEvent(p1, p2, target, eventType, direction, 1.0,1.0,1.0,1.0)
//               (9-arg form — baguette tddworks/baguette analysis)
//
// Reference: baguette (tddworks/baguette), SimulatorKit _hidEventFilterCallback analysis.

import Foundation
import CoreGraphics
import ObjectiveC

// MARK: - Args

guard CommandLine.arguments.count == 2 else {
    fputs("usage: touch-helper <udid|booted>\n", stderr)
    exit(1)
}
let targetUDID = CommandLine.arguments[1]

// MARK: - Framework loading

// Xcode ≤26 ships SimulatorKit inside the developer dir. Xcode 27 moved it to Contents/SharedFrameworks,
// a sibling of Contents/Developer, so appending to what xcode-select reports no longer reaches it.
// Both are probed on the selected Xcode before any other Xcode is: with 27 selected and an older Xcode
// in /Applications, a fallback that knows only the old path loads that older SimulatorKit instead.
func simulatorKitCandidates(_ developerDir: String) -> [String] {
    let contents = (developerDir as NSString).deletingLastPathComponent
    return [
        (developerDir as NSString).appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"),
        (contents as NSString).appendingPathComponent("SharedFrameworks/SimulatorKit.framework/SimulatorKit"),
    ]
}

func findSimulatorKit() -> (developerDir: String, path: String?, searched: [String]) {
    let defaultDir = "/Applications/Xcode.app/Contents/Developer"
    var searched: [String] = []
    func probe(_ d: String) -> String? {
        let candidates = simulatorKitCandidates(d)
        searched += candidates
        return candidates.first { FileManager.default.fileExists(atPath: $0) }
    }

    let pipe = Pipe()
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    task.arguments = ["-p"]
    task.standardOutput = pipe
    do { try task.run() } catch {
        let path = probe(defaultDir)
        return (defaultDir, path, searched)
    }
    task.waitUntilExit()
    let dir = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    if !dir.isEmpty, let path = probe(dir) { return (dir, path, searched) }
    // xcode-select may point to CLT which lacks SimulatorKit — scan /Applications
    let apps = (try? FileManager.default.contentsOfDirectory(atPath: "/Applications")) ?? []
    for app in apps.sorted() where app.hasPrefix("Xcode") && app.hasSuffix(".app") {
        let d = "/Applications/\(app)/Contents/Developer"
        if d != dir, let path = probe(d) { return (d, path, searched) }
    }
    return (dir.isEmpty ? defaultDir : dir, nil, searched)
}

let simulatorKit = findSimulatorKit()
let developerDir = simulatorKit.developerDir

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
             RTLD_NOW | RTLD_GLOBAL) != nil else {
    if let e = dlerror() { fputs("error: CoreSimulator: \(String(cString: e))\n", stderr) }
    exit(1)
}
guard let simkitPath = simulatorKit.path else {
    let searched = simulatorKit.searched.map { "  \($0)\n" }.joined()
    fputs("error: SimulatorKit not found. Searched:\n\(searched)", stderr)
    exit(1)
}
// Which SimulatorKit is about to load is the one fact a machine with two Xcodes cannot show otherwise.
fputs("info: SimulatorKit \(simkitPath)\n", stderr)
guard let skHandle = dlopen(simkitPath, RTLD_NOW | RTLD_GLOBAL) else {
    if let e = dlerror() { fputs("error: SimulatorKit: \(String(cString: e))\n", stderr) }
    exit(1)
}

// MARK: - IndigoHID function pointers

// IndigoHIDMessageForMouseNSEvent(p1, p2, target, eventType, size, edge) -> IndigoHIDMessageStruct*
// C signature: (CGPoint*, CGPoint*, IndigoHIDTarget, NSEventType, NSSize, IndigoHIDEdge)
// p1: pointer to current position (normalized 0.0–1.0)
// p2: pointer to movement delta (zero for tap/drag)
// target: IndigoHIDTarget = 0x32
// eventType: NSEventType raw value — NSUInteger (1=leftMouseDown, 2=leftMouseUp, 6=leftMouseDragged)
// size: coordinate space size (1.0×1.0 for normalized coords)
// edge: 0
typealias IndigoMouseFn = @convention(c) (
    UnsafePointer<CGPoint>, UnsafePointer<CGPoint>, UInt32, UInt, CGSize, UInt32
) -> UnsafeMutableRawPointer?

// 9-arg form for two-finger touch (baguette pattern).
// p1/p2 = normalized 0–1 positions of each finger.
// direction: 1=down, 0=move, 2=up (separate from NSEventType).
// The four trailing Doubles fill float registers d0–d3; 1.0,1.0 are unused, last two are size.
typealias IndigoMouseTwoFingerFn = @convention(c) (
    UnsafePointer<CGPoint>, UnsafePointer<CGPoint>, UInt32, UInt32, UInt32,
    Double, Double, Double, Double
) -> UnsafeMutableRawPointer?

// IndigoHIDMessageForHIDArbitrary(target, usagePage, usage, op) -> IndigoHIDMessageStruct*
// Used for hardware button injection (volume, power, action, mute).
// op: 1=down, 2=up. target: 0x32 (same digitizer target as touch).
typealias IndigoHIDArbitraryFn = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?

// IndigoHIDMessageForButton(buttonCode, op, target) -> IndigoHIDMessageStruct*
// Legacy button path — used for home (code=0) and lock (code=1) buttons.
// op: 1=down, 2=up. target: 0x33.
typealias IndigoHIDButtonFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?

func requireSym<T>(_ handle: UnsafeMutableRawPointer?, _ name: String) -> T {
    guard let sym = dlsym(handle, name) else {
        fputs("error: symbol not found: \(name)\n", stderr)
        exit(1)
    }
    return unsafeBitCast(sym, to: T.self)
}

let indigoMouse: IndigoMouseFn = requireSym(skHandle, "IndigoHIDMessageForMouseNSEvent")
let indigoMouseTwoFinger: IndigoMouseTwoFingerFn = requireSym(skHandle, "IndigoHIDMessageForMouseNSEvent")

let indigoArbitrary: IndigoHIDArbitraryFn? = {
    guard let sym = dlsym(skHandle, "IndigoHIDMessageForHIDArbitrary") else {
        fputs("warn: IndigoHIDMessageForHIDArbitrary not found — HID button injection disabled\n", stderr)
        return nil
    }
    return unsafeBitCast(sym, to: IndigoHIDArbitraryFn.self)
}()

let indigoButton: IndigoHIDButtonFn? = {
    guard let sym = dlsym(skHandle, "IndigoHIDMessageForButton") else {
        fputs("warn: IndigoHIDMessageForButton not found — legacy button injection disabled\n", stderr)
        return nil
    }
    return unsafeBitCast(sym, to: IndigoHIDButtonFn.self)
}()

// IndigoHIDMessageForKeyboardArbitrary(usageCode, op) -> IndigoHIDMessageStruct*
// Keyboard-specific variant: uses the hardware keyboard service target internally.
// Unlike IndigoHIDMessageForHIDArbitrary(target=0x32,...) which routes through the digitizer path,
// this routes through the real keyboard HID service — iOS recognises events as hardware keyboard input,
// enabling input-source-aware character translation and CapsLock / language-toggle HUD.
typealias IndigoKeyboardArbitraryFn = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?

let indigoKeyboard: IndigoKeyboardArbitraryFn? = {
    guard let sym = dlsym(skHandle, "IndigoHIDMessageForKeyboardArbitrary") else {
        fputs("warn: IndigoHIDMessageForKeyboardArbitrary not found — keyboard uses HIDArbitrary fallback\n", stderr)
        return nil
    }
    return unsafeBitCast(sym, to: IndigoKeyboardArbitraryFn.self)
}()

// MARK: - IOHIDDigitizerDispatch symbols
// Mouse-class events (IndigoHIDMessageForMouseNSEvent) are ignored by UIBackdropView
// and other system gesture layers. The digitizer path builds a display-integrated
// IOHIDEvent pair (parent + finger child) that iOS treats as a real finger touch.
// Reference: baguette (tddworks/baguette) IOHIDDigitizerDispatch.swift (verified 2026-05-18)

typealias IOHIDEventCreateDigitizerEventFn = @convention(c) (
    OpaquePointer?,                              // allocator (nil = kCFAllocatorDefault)
    UInt64,                                      // timestamp (mach_absolute_time)
    UInt32, UInt32, UInt32, UInt32, UInt32,      // transducerType, index, identity, eventMask, buttonMask
    Double, Double, Double, Double, Double,      // x, y, z, tipPressure, barrelPressure
    UInt32, UInt32,                              // range, touch (boolean_t = UInt32)
    UInt32                                       // options
) -> OpaquePointer?

typealias IOHIDEventCreateDigitizerFingerEventFn = @convention(c) (
    OpaquePointer?,                              // allocator
    UInt64,                                      // timestamp
    UInt32, UInt32, UInt32,                      // index, identity, eventMask
    Double, Double, Double, Double, Double,      // x, y, z, tipPressure, twist
    UInt32, UInt32,                              // range, touch
    UInt32                                       // options
) -> OpaquePointer?

typealias IOHIDEventAppendEventFn = @convention(c) (OpaquePointer, OpaquePointer, UInt32) -> Void
typealias IndigoTrackpadFn        = @convention(c) (OpaquePointer) -> UnsafeMutableRawPointer?

// IOKit symbols live in the dyld shared cache; explicit dlopen ensures they are findable.
// RTLD_DEFAULT is a C macro ((void*)-2) not importable in Swift — use the explicit handle instead.
let ioKitHandle = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW | RTLD_GLOBAL)

let mkDigitizer: IOHIDEventCreateDigitizerEventFn? = {
    guard let sym = dlsym(ioKitHandle, "IOHIDEventCreateDigitizerEvent") else { return nil }
    return unsafeBitCast(sym, to: IOHIDEventCreateDigitizerEventFn.self)
}()

let mkFinger: IOHIDEventCreateDigitizerFingerEventFn? = {
    guard let sym = dlsym(ioKitHandle, "IOHIDEventCreateDigitizerFingerEvent") else { return nil }
    return unsafeBitCast(sym, to: IOHIDEventCreateDigitizerFingerEventFn.self)
}()

let appendEv: IOHIDEventAppendEventFn? = {
    guard let sym = dlsym(ioKitHandle, "IOHIDEventAppendEvent") else { return nil }
    return unsafeBitCast(sym, to: IOHIDEventAppendEventFn.self)
}()

let indigoTrackpad: IndigoTrackpadFn? = {
    guard let sym = dlsym(skHandle, "IndigoHIDMessageForTrackpadEventFromHIDEventRef") else {
        fputs("warn: IndigoHIDMessageForTrackpadEventFromHIDEventRef not found — mouse fallback active\n", stderr)
        return nil
    }
    return unsafeBitCast(sym, to: IndigoTrackpadFn.self)
}()

let useDigitizerPath = mkDigitizer != nil && mkFinger != nil && appendEv != nil && indigoTrackpad != nil

// MARK: - ObjC runtime helpers

func classInvoke(_ cls: AnyClass, _ sel: Selector, _ arg: AnyObject,
                 err: inout NSError?) -> NSObject? {
    guard let meta = object_getClass(cls),
          let imp  = class_getMethodImplementation(meta, sel) else { return nil }
    typealias Fn = @convention(c) (AnyClass, Selector, AnyObject,
                                   AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(cls, sel, arg, &err) as? NSObject
}

func instanceInvoke(_ obj: NSObject, _ sel: Selector,
                    err: inout NSError?) -> NSObject? {
    guard let imp = class_getMethodImplementation(type(of: obj), sel) else { return nil }
    typealias Fn = @convention(c) (AnyObject, Selector,
                                   AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(obj, sel, &err) as? NSObject
}

// MARK: - Device resolution

func resolveDevice(udid: String) -> NSObject? {
    guard let cls = NSClassFromString("SimServiceContext") else { return nil }
    var err: NSError?
    guard let ctx = classInvoke(cls,
        NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
        developerDir as NSString, err: &err) else { return nil }
    guard let set = instanceInvoke(ctx,
        NSSelectorFromString("defaultDeviceSetWithError:"), err: &err) else { return nil }
    let devices = (set.value(forKey: "availableDevices") as? [NSObject]) ?? []
    if udid == "booted" {
        return devices.first { ($0.value(forKey: "state") as? NSNumber)?.uintValue == 3 }
    }
    return devices.first { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }
}

guard let device = resolveDevice(udid: targetUDID) else {
    fputs("error: device not found (udid=\(targetUDID))\n", stderr)
    exit(1)
}

// MARK: - SimDeviceLegacyHIDClient

func createHIDClient(device: NSObject) -> NSObject? {
    guard let cls = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else {
        fputs("error: SimDeviceLegacyHIDClient class not found\n", stderr)
        return nil
    }
    guard let metaCls = object_getClass(cls),
          let allocImp = class_getMethodImplementation(metaCls, NSSelectorFromString("alloc")) else { return nil }
    typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject
    let allocSel = NSSelectorFromString("alloc")
    let allocated = unsafeBitCast(allocImp, to: AllocFn.self)(cls, allocSel) as! NSObject

    let initSel = NSSelectorFromString("initWithDevice:error:")
    guard let initImp = class_getMethodImplementation(type(of: allocated), initSel) else { return nil }
    typealias InitFn = @convention(c) (NSObject, Selector, NSObject,
                                       AutoreleasingUnsafeMutablePointer<NSError?>) -> NSObject?
    var initErr: NSError?
    let client = unsafeBitCast(initImp, to: InitFn.self)(allocated, initSel, device, &initErr)
    if let err = initErr {
        fputs("error: initWithDevice: \(err.localizedDescription)\n", stderr)
    }
    return client
}

guard let hidClient = createHIDClient(device: device) else {
    fputs("error: failed to create SimDeviceLegacyHIDClient\n", stderr)
    exit(1)
}
fputs("info: touch-helper ready (udid=\(targetUDID)) digitizer=\(useDigitizerPath)\n", stderr)

// MARK: - sendWithMessage IMP

let sendSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
guard let sendImp = class_getMethodImplementation(type(of: hidClient), sendSel) else {
    fputs("error: sendWithMessage:freeWhenDone:completionQueue:completion: not found\n", stderr)
    exit(1)
}
typealias SendFn = @convention(c) (NSObject, Selector, UnsafeMutableRawPointer, Bool,
                                   AnyObject?, AnyObject?) -> Void
let sendMsg = unsafeBitCast(sendImp, to: SendFn.self)

// MARK: - Touch injection

// NSEventType (NSUInteger) raw values
let kNSLeftMouseDown: UInt    = 1
let kNSLeftMouseUp: UInt      = 2
let kNSLeftMouseDragged: UInt = 6

// Direction values for the 9-arg two-finger form
let kDirDown: UInt32 = 1
let kDirMove: UInt32 = 0
let kDirUp:   UInt32 = 2

// IndigoHIDTarget for digitizer/touch (from SimulatorKit + baguette analysis)
let kIndigoHIDTargetDigitizer: UInt32 = 0x32

let kNormalizedSize = CGSize(width: 1.0, height: 1.0)

/// Returns whether the event went out on the digitizer path, which is the one a cancel can be sent on.
@discardableResult
func inject(x: Double, y: Double, eventType: UInt) -> Bool {
    if useDigitizerPath {
        return injectDigitizer(x: x, y: y, eventType: eventType)
    }
    injectMouse(x: x, y: y, eventType: eventType)
    return false
}

func injectMouse(x: Double, y: Double, eventType: UInt) {
    var position = CGPoint(x: x, y: y)
    var delta    = CGPoint.zero
    guard let msgPtr = indigoMouse(&position, &delta, kIndigoHIDTargetDigitizer,
                                   eventType, kNormalizedSize, 0) else {
        fputs("warn: IndigoHIDMessageForMouseNSEvent returned nil\n", stderr)
        return
    }
    sendMsg(hidClient, sendSel, msgPtr, true, nil, nil)
}

// Digitizer path: builds IOHIDEvent parent+finger pair → IndigoHIDMessageForTrackpadEventFromHIDEventRef.
// UIBackdropView (folder blur) and system gesture layers only respond to digitizer-class events;
// mouse-class events from IndigoHIDMessageForMouseNSEvent are silently ignored by those layers.
// byte patches: 0x6c/0x10c = 0x32 (kIOHIDEventFieldDigitizerIsDisplayIntegrated — marks as real finger)
//
// `cancel` lifts the touch as cancelled (#1115): mask Range|Touch|Cancel (0x83) with no contact, which the app receives
// as `touchesCancelled` rather than a tap — measured on Xcode 26 and 27.1, UIKit and SwiftUI. It returns false instead
// of falling back to the mouse path, whose events carry no cancel: the caller then sends an up.
@discardableResult
func injectDigitizer(x: Double, y: Double, eventType: UInt, cancel: Bool = false) -> Bool {
    guard let createParent = mkDigitizer, let createFinger = mkFinger,
          let appendFn = appendEv, let trackpadFn = indigoTrackpad else {
        if cancel { return false }
        injectMouse(x: x, y: y, eventType: eventType); return false
    }
    let ts = mach_absolute_time()
    let isUp: Bool      = eventType == kNSLeftMouseUp || cancel
    let mask: UInt32    = cancel ? 0x83 : isUp ? 0x06 : 0x07   // 0x07=Range|Touch|Position, 0x06=Touch|Position, 0x83=Range|Touch|Cancel
    let contact: UInt32 = isUp ? 0 : 1
    guard let parent = createParent(nil, ts, 2, 0, 1, mask, 0, x, y, 0, 0, 0, contact, contact, 0),
          let finger = createFinger(nil, ts, 1, 1, mask, x, y, 0, 0, 0, contact, contact, 0) else {
        fputs("warn: IOHIDEventCreate returned nil — mouse fallback\n", stderr)
        if cancel { return false }
        injectMouse(x: x, y: y, eventType: eventType); return false
    }
    appendFn(parent, finger, 0)
    guard let msgPtr = trackpadFn(parent) else {
        fputs("warn: IndigoHIDMessageForTrackpadEventFromHIDEventRef returned nil\n", stderr)
        if cancel { return false }
        injectMouse(x: x, y: y, eventType: eventType); return false
    }
    // Routing tag: iOS ignores trackpad messages without this — including normal UI touches.
    // Use malloc_size (not a header field) to safely check the second slot.
    msgPtr.storeBytes(of: UInt32(0x32), toByteOffset: 0x6c, as: UInt32.self)
    if malloc_size(msgPtr) >= 0x110 {
        msgPtr.storeBytes(of: UInt32(0x32), toByteOffset: 0x10c, as: UInt32.self)
    }
    sendMsg(hidClient, sendSel, msgPtr, true, nil, nil)
    return true
}

func injectTwoFinger(x1: Double, y1: Double, x2: Double, y2: Double, direction: UInt32) {
    let eventType: UInt32 = direction == kDirDown ? UInt32(kNSLeftMouseDown)
                          : direction == kDirUp   ? UInt32(kNSLeftMouseUp)
                          :                         UInt32(kNSLeftMouseDragged)
    var p1 = CGPoint(x: x1, y: y1)
    var p2 = CGPoint(x: x2, y: y2)
    // The function may return nil for ~60 ms after a two-finger down while
    // SimulatorKit settles the multi-touch state — retry up to 12× (baguette pattern).
    var msgPtr: UnsafeMutableRawPointer? = nil
    for _ in 0..<12 {
        msgPtr = indigoMouseTwoFinger(&p1, &p2, kIndigoHIDTargetDigitizer,
                                     eventType, direction, 1.0, 1.0, 1.0, 1.0)
        if msgPtr != nil { break }
        Thread.sleep(forTimeInterval: 0.005)
    }
    guard let ptr = msgPtr else {
        fputs("warn: two-finger IndigoHIDMessageForMouseNSEvent returned nil\n", stderr)
        return
    }
    sendMsg(hidClient, sendSel, ptr, true, nil, nil)
}

// MARK: - Button injection

let kIndigoHIDTargetButton: UInt32 = 0x33  // legacy button service target
let kHIDOpDown: UInt32 = 1
let kHIDOpUp:   UInt32 = 2

// HIDArbitrary: for volume, power, action, mute — uses usagePage+usage from chrome.json
func pressButton(usagePage: UInt32, usage: UInt32) {
    guard let indigoArb = indigoArbitrary else {
        fputs("warn: HID button unavailable (page=\(usagePage) usage=\(usage))\n", stderr)
        return
    }
    if let msgDown = indigoArb(kIndigoHIDTargetDigitizer, usagePage, usage, kHIDOpDown) {
        sendMsg(hidClient, sendSel, msgDown, true, nil, nil)
    }
    Thread.sleep(forTimeInterval: 0.05)
    if let msgUp = indigoArb(kIndigoHIDTargetDigitizer, usagePage, usage, kHIDOpUp) {
        sendMsg(hidClient, sendSel, msgUp, true, nil, nil)
    }
}

// Separate down/up so the dashboard can hold a button for its real duration (e.g. Action
// button long-press). The hold time is the gap between the down and up frames on stdin.
func pressButtonDown(usagePage: UInt32, usage: UInt32) {
    guard let indigoArb = indigoArbitrary else {
        fputs("warn: HID button unavailable (page=\(usagePage) usage=\(usage))\n", stderr)
        return
    }
    if let msgDown = indigoArb(kIndigoHIDTargetDigitizer, usagePage, usage, kHIDOpDown) {
        sendMsg(hidClient, sendSel, msgDown, true, nil, nil)
    }
}

func pressButtonUp(usagePage: UInt32, usage: UInt32) {
    guard let indigoArb = indigoArbitrary else { return }
    if let msgUp = indigoArb(kIndigoHIDTargetDigitizer, usagePage, usage, kHIDOpUp) {
        sendMsg(hidClient, sendSel, msgUp, true, nil, nil)
    }
}

// Keyboard: HID usage page 0x07 (Keyboard/Keypad).
// modifiers: USB HID modifier bitmap — bit0=LeftCtrl, bit1=LeftShift, bit2=LeftAlt, bit3=LeftGUI, …
// Sends modifier-down → key-down → key-up → modifier-up sequence.
// Primary path: IndigoHIDMessageForKeyboardArbitrary — uses the hardware keyboard service target
// so iOS treats events as real hardware keyboard input (enables input-source switching and CapsLock HUD).
// Fallback: IndigoHIDMessageForHIDArbitrary(digitizer target) for older Xcode versions.
func sendKey(modifiers: UInt8, usage: UInt32) {
    let modifierMap: [(bit: UInt8, usage: UInt32)] = [
        (0x01, 0xE0), // LeftCtrl
        (0x02, 0xE1), // LeftShift
        (0x04, 0xE2), // LeftAlt
        (0x08, 0xE3), // LeftMeta
        (0x10, 0xE4), // RightCtrl
        (0x20, 0xE5), // RightShift
        (0x40, 0xE6), // RightAlt
        (0x80, 0xE7), // RightMeta
    ]

    func kbdMsg(_ u: UInt32, _ op: UInt32) {
        let ptr: UnsafeMutableRawPointer?
        if let fn = indigoKeyboard {
            ptr = fn(u, op)
        } else if let fn = indigoArbitrary {
            ptr = fn(kIndigoHIDTargetDigitizer, 0x07, u, op)
        } else {
            fputs("warn: no keyboard HID function available\n", stderr)
            return
        }
        if let p = ptr { sendMsg(hidClient, sendSel, p, true, nil, nil) }
    }

    for (bit, modUsage) in modifierMap where modifiers & bit != 0 { kbdMsg(modUsage, kHIDOpDown) }
    kbdMsg(usage, kHIDOpDown)
    kbdMsg(usage, kHIDOpUp)
    for (bit, modUsage) in modifierMap.reversed() where modifiers & bit != 0 { kbdMsg(modUsage, kHIDOpUp) }
}

// MARK: - Legacy button injection

func pressLegacyButton(code: UInt32) {
    guard let indigoBtn = indigoButton else {
        fputs("warn: legacy button unavailable (code=\(code))\n", stderr)
        return
    }
    if let msgDown = indigoBtn(code, kHIDOpDown, kIndigoHIDTargetButton) {
        sendMsg(hidClient, sendSel, msgDown, true, nil, nil)
    }
    Thread.sleep(forTimeInterval: 0.05)
    if let msgUp = indigoBtn(code, kHIDOpUp, kIndigoHIDTargetButton) {
        sendMsg(hidClient, sendSel, msgUp, true, nil, nil)
    }
}

// MARK: - Stdin read loop

// How the current single-finger touch went down: none, the digitizer path (cancellable) or the mouse path (not).
// A cancel with nothing down is dropped: one sent with no touch in progress crashed backboardd in another tool.
enum TouchDown { case none, digitizer, mouse }
var touchDown = TouchDown.none
var lastX: Double = 0
var lastY: Double = 0
var pinchLastX1: Double = 0
var pinchLastY1: Double = 0
var pinchLastX2: Double = 0
var pinchLastY2: Double = 0

let stdinFH = FileHandle.standardInput

func readExact(length: Int) -> Data? {
    let d = stdinFH.readData(ofLength: length)
    return d.count == length ? d : nil
}

func f32BE(_ data: Data, offset: Int) -> Double {
    let bits = data.subdata(in: offset..<offset+4).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
    return Double(Float(bitPattern: bits))
}

func u32BE(_ data: Data, offset: Int) -> UInt32 {
    return data.subdata(in: offset..<offset+4).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
}

// OpenClaw lifecycle patch: cancel an owned touch before the helper exits.
// A one-byte stdout acknowledgment lets the owner wait for injection before termination.
func cancelCurrentTouch() {
    let down = touchDown
    touchDown = .none
    if down == .none { return }
    if down == .digitizer && injectDigitizer(x: lastX, y: lastY, eventType: kNSLeftMouseUp, cancel: true) { return }
    inject(x: lastX, y: lastY, eventType: kNSLeftMouseUp)
}

func exitAfterInputEOF() -> Never {
    cancelCurrentTouch()
    // EOF follows every queued frame; this distinct fence acknowledges final release.
    FileHandle.standardOutput.write(Data([2]))
    exit(0)
}

DispatchQueue.global(qos: .userInteractive).async {
    while true {
        guard let header = readExact(length: 1) else { exitAfterInputEOF() }
        let type = header[0]

        switch type {
        case 6, 7, 8:
            // Two-finger frame: 16 bytes — x1,y1,x2,y2 as float32BE
            guard let rest = readExact(length: 16) else { exitAfterInputEOF() }
            let x1 = f32BE(rest, offset: 0)
            let y1 = f32BE(rest, offset: 4)
            let x2 = f32BE(rest, offset: 8)
            let y2 = f32BE(rest, offset: 12)
            switch type {
            case 6:
                touchDown = .none
                pinchLastX1 = x1; pinchLastY1 = y1
                pinchLastX2 = x2; pinchLastY2 = y2
                injectTwoFinger(x1: x1, y1: y1, x2: x2, y2: y2, direction: kDirDown)
            case 7:
                pinchLastX1 = x1; pinchLastY1 = y1
                pinchLastX2 = x2; pinchLastY2 = y2
                injectTwoFinger(x1: x1, y1: y1, x2: x2, y2: y2, direction: kDirMove)
            case 8:
                injectTwoFinger(x1: pinchLastX1, y1: pinchLastY1,
                                x2: pinchLastX2, y2: pinchLastY2, direction: kDirUp)
            default: break
            }
        default:
            // Single-finger / button frame: 8 bytes
            guard let rest = readExact(length: 8) else { exitAfterInputEOF() }
            let x = f32BE(rest, offset: 0)
            let y = f32BE(rest, offset: 4)
            switch type {
            case 1:
                lastX = x; lastY = y
                touchDown = inject(x: x, y: y, eventType: kNSLeftMouseDown) ? .digitizer : .mouse
            case 2:
                lastX = x; lastY = y
                inject(x: x, y: y, eventType: kNSLeftMouseDragged)
            case 3:
                touchDown = .none
                inject(x: lastX, y: lastY, eventType: kNSLeftMouseUp)
            case 13:
                cancelCurrentTouch()
                FileHandle.standardOutput.write(Data([1]))
            case 4:
                let usagePage = u32BE(rest, offset: 0)
                let usage     = u32BE(rest, offset: 4)
                pressButton(usagePage: usagePage, usage: usage)
            case 5:
                let code = u32BE(rest, offset: 0)
                pressLegacyButton(code: code)
            case 10:
                let usagePage = u32BE(rest, offset: 0)
                let usage     = u32BE(rest, offset: 4)
                pressButtonDown(usagePage: usagePage, usage: usage)
            case 11:
                let usagePage = u32BE(rest, offset: 0)
                let usage     = u32BE(rest, offset: 4)
                pressButtonUp(usagePage: usagePage, usage: usage)
            case 9:
                let modifier = rest[0]
                let usage    = u32BE(rest, offset: 4)
                sendKey(modifiers: modifier, usage: usage)
            default: break
            }
        }
    }
}

RunLoop.main.run()
