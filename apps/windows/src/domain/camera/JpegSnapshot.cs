namespace OpenClawWindows.Domain.Camera;

// camera.snap response payload — matches macOS CameraCaptureService output exactly.
public sealed record JpegSnapshot
{
    public string Base64 { get; }
    public int Width { get; }
    public int Height { get; }
    public string Format => "jpeg";

    private JpegSnapshot(string base64, int width, int height)
    {
        Base64 = base64;
        Width = width;
        Height = height;
    }

    public static ErrorOr<JpegSnapshot> Create(string base64, int width, int height)
    {
        Guard.Against.NullOrWhiteSpace(base64, nameof(base64));
        Guard.Against.NegativeOrZero(width, nameof(width));
        Guard.Against.NegativeOrZero(height, nameof(height));

        return new JpegSnapshot(base64, width, height);
    }
}
