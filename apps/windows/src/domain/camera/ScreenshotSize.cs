using System.Buffers.Binary;

namespace OpenClawWindows.Domain.Camera;

/// <summary>
/// Utility for reading PNG image dimensions from raw bytes.
/// chunk directly instead, which avoids WinRT/GDI+ dependencies in the domain layer.
/// </summary>
public static class ScreenshotSize
{
    public readonly record struct Size(int Width, int Height);

    // PNG binary layout constants
    private static ReadOnlySpan<byte> Signature => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    private const int WidthOffset  = 16; // 8 sig + 4 length + 4 "IHDR" type
    private const int HeightOffset = 20;
    private const int MinLength    = 24; // must reach end of height field

    // Reads width and height from the IHDR chunk of a PNG byte array.
    // Returns null for non-PNG or truncated data.
    public static Size? ReadPngSize(byte[]? data)
    {
        if (data is null || data.Length < MinLength) return null;
        if (!data.AsSpan(0, 8).SequenceEqual(Signature)) return null;

        var width  = BinaryPrimitives.ReadInt32BigEndian(data.AsSpan(WidthOffset,  4));
        var height = BinaryPrimitives.ReadInt32BigEndian(data.AsSpan(HeightOffset, 4));

        return new Size(width, height);
    }
}
