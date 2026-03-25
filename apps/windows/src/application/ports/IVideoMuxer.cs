namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Muxes raw video frames and audio into an MP4 byte stream.
/// Implemented by FFmpegVideoMuxerAdapter (FFMpegCore).
/// </summary>
public interface IVideoMuxer
{
    Task<ErrorOr<byte[]>> MuxAsync(
        byte[] videoFrames, byte[]? audioData,
        int width, int height,
        int durationMs, int fps,
        CancellationToken ct);
}
