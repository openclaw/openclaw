using OpenClawWindows.Presentation.Helpers;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class ViewMetricsTests
{
    // Mirrors Swift: ViewMetricsTesting.reduceWidth — max(current, next)
    [Theory]
    [InlineData(100.0, 200.0, 200.0)]
    [InlineData(300.0, 150.0, 300.0)]
    [InlineData(0.0, 0.0, 0.0)]
    [InlineData(42.5, 42.5, 42.5)]
    public void ReduceWidth_ReturnsMax(double current, double next, double expected)
        => Assert.Equal(expected, ViewMetrics.ReduceWidth(current, next));
}
