using System.Diagnostics;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.Camera;

// Muxes raw video frames + optional PCM audio into MP4 via ffmpeg CLI.
// Uses System.Diagnostics.Process to invoke ffmpeg directly — avoids pinning
// to specific FFMpegCore API surface which may vary across .NET 9 / ARM64.
internal sealed class FFmpegVideoMuxerAdapter : IVideoMuxer
{
    private readonly ILogger<FFmpegVideoMuxerAdapter> _logger;

    public FFmpegVideoMuxerAdapter(ILogger<FFmpegVideoMuxerAdapter> logger)
    {
        _logger = logger;
    }

    public async Task<ErrorOr<byte[]>> MuxAsync(
        byte[] videoFrames, byte[]? audioData,
        int width, int height,
        int durationMs, int fps,
        CancellationToken ct)
    {
        if (videoFrames.Length == 0)
            return Error.Failure("No frames captured");

        var outputPath = Path.Combine(Path.GetTempPath(), $"openclaw-{Guid.NewGuid():N}.mp4");

        try
        {
            // ffmpeg reads raw BGRA32 from stdin and writes MP4 to disk
            var args = BuildFfmpegArgs(width, height, fps, outputPath, audioData is { Length: > 0 });

            var psi = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var arg in args)
                psi.ArgumentList.Add(arg);

            using var process = new Process { StartInfo = psi };
            process.Start();

            // Write raw frames to stdin
            await process.StandardInput.BaseStream.WriteAsync(videoFrames, ct);
            if (audioData is { Length: > 0 })
                await process.StandardInput.BaseStream.WriteAsync(audioData, ct);
            await process.StandardInput.BaseStream.FlushAsync(ct);
            process.StandardInput.Close();

            await process.WaitForExitAsync(ct);

            if (process.ExitCode != 0)
            {
                var stderr = await process.StandardError.ReadToEndAsync(ct);
                _logger.LogError("ffmpeg exited {Code}: {Err}", process.ExitCode, stderr);
                return Error.Failure("FFMPEG_FAILED", $"ffmpeg exit {process.ExitCode}");
            }

            if (!File.Exists(outputPath))
                return Error.Failure("FFMPEG_NO_OUTPUT");

            return await File.ReadAllBytesAsync(outputPath, ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Video mux failed (durationMs={D}, fps={F})", durationMs, fps);
            return Error.Failure($"Video mux error: {ex.Message}");
        }
        finally
        {
            if (File.Exists(outputPath))
                File.Delete(outputPath);
        }
    }

    private static string[] BuildFfmpegArgs(
        int width, int height, int fps, string outputPath, bool hasAudio)
    {
        // -s must be provided for rawvideo — ffmpeg cannot infer frame size from raw bytes.
        // yuv420p requires even dimensions; clamp to the nearest even pixel if needed.
        var w = width % 2 == 0 ? width : width - 1;
        var h = height % 2 == 0 ? height : height - 1;

        return new[]
        {
            "-y",
            "-f", "rawvideo",
            "-pix_fmt", "bgra",
            "-s", $"{w}x{h}",
            "-r", fps.ToString(),
            "-i", "pipe:0",
            "-vcodec", "libx264",
            "-crf", "23",
            "-movflags", "+faststart",
            "-pix_fmt", "yuv420p",
            outputPath,
        };
    }
}
