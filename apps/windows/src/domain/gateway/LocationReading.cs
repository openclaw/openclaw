namespace OpenClawWindows.Domain.Gateway;

// location.get response payload — raw doubles to match macOS/gateway protocol exactly.
public sealed record LocationReading
{
    public double Latitude { get; }
    public double Longitude { get; }
    public double Accuracy { get; }
    public double? Altitude { get; }
    public double? Speed { get; }
    public double? Heading { get; }
    public long Timestamp { get; }  // epoch ms
    public bool IsPrecise { get; }

    private LocationReading(double latitude, double longitude, double accuracy,
        double? altitude, double? speed, double? heading, long timestamp, bool isPrecise)
    {
        Latitude = latitude;
        Longitude = longitude;
        Accuracy = accuracy;
        Altitude = altitude;
        Speed = speed;
        Heading = heading;
        Timestamp = timestamp;
        IsPrecise = isPrecise;
    }

    public static LocationReading Create(double latitude, double longitude, double accuracy,
        double? altitude, double? speed, double? heading, long timestamp, bool isPrecise = true)
    {
        Guard.Against.OutOfRange(latitude, nameof(latitude), -90.0, 90.0);
        Guard.Against.OutOfRange(longitude, nameof(longitude), -180.0, 180.0);

        return new LocationReading(latitude, longitude, accuracy, altitude, speed, heading, timestamp, isPrecise);
    }
}
