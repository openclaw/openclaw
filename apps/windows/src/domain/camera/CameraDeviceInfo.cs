namespace OpenClawWindows.Domain.Camera;

// camera.list entry — id/name/position/deviceType match the CameraCommands schema.
public sealed record CameraDeviceInfo
{
    public string Id { get; }
    public string Name { get; }
    public string Position { get; }       // "front" | "back" | "unspecified"
    public string DeviceType { get; }     // e.g. "builtInWideAngleCamera"

    private CameraDeviceInfo(string id, string name, string position, string deviceType)
    {
        Id = id;
        Name = name;
        Position = position;
        DeviceType = deviceType;
    }

    // Mapping from WinRT DeviceInformation happens in WinRTCameraAdapter (Infrastructure layer).
    public static CameraDeviceInfo Create(string id, string name, string position, string deviceType)
    {
        Guard.Against.NullOrWhiteSpace(id, nameof(id));
        Guard.Against.NullOrWhiteSpace(name, nameof(name));

        return new CameraDeviceInfo(id, name,
            position ?? "unspecified",
            deviceType ?? "builtInWideAngleCamera");
    }
}
