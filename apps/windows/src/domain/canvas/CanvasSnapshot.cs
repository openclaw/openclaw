namespace OpenClawWindows.Domain.Canvas;

public sealed record CanvasSnapshot
{
    public string Base64 { get; }
    public int Width { get; }
    public int Height { get; }

    private CanvasSnapshot(string base64, int width, int height)
    {
        Base64 = base64;
        Width = width;
        Height = height;
    }

    public static ErrorOr<CanvasSnapshot> Create(string base64, int width, int height)
    {
        Guard.Against.NullOrWhiteSpace(base64, nameof(base64));
        Guard.Against.NegativeOrZero(width, nameof(width));
        Guard.Against.NegativeOrZero(height, nameof(height));

        return new CanvasSnapshot(base64, width, height);
    }
}
