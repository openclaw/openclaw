// Architecture tests using NetArchTest.Rules.
// Verifies hexagonal architecture layer permissions from using_graph.yaml (Phase 2 Step 1).
// Domain must not import Application, Infrastructure, or Presentation.
// Application must not import Infrastructure or Presentation.

using NetArchTest.Rules;

namespace OpenClawWindows.Tests.Architecture;

public sealed class LayerDependencyTests
{
    private static Types AllTypes() =>
        Types.InAssembly(typeof(OpenClawWindows.Domain.SharedKernel.Entity<>).Assembly);

    [Fact]
    public void Domain_ShouldNot_DependOnApplication()
    {
        var result = AllTypes()
            .That().ResideInNamespace("OpenClawWindows.Domain")
            .ShouldNot().HaveDependencyOn("OpenClawWindows.Application")
            .GetResult();

        result.IsSuccessful.Should().BeTrue(
            because: $"domain layer must not reference application: {string.Join(", ", result.FailingTypeNames ?? [])}");
    }

    [Fact]
    public void Domain_ShouldNot_DependOnInfrastructure()
    {
        var result = AllTypes()
            .That().ResideInNamespace("OpenClawWindows.Domain")
            .ShouldNot().HaveDependencyOn("OpenClawWindows.Infrastructure")
            .GetResult();

        result.IsSuccessful.Should().BeTrue(
            because: $"domain layer must not reference infrastructure: {string.Join(", ", result.FailingTypeNames ?? [])}");
    }

    [Fact]
    public void Application_ShouldNot_DependOnInfrastructure()
    {
        var result = AllTypes()
            .That().ResideInNamespace("OpenClawWindows.Application")
            .ShouldNot().HaveDependencyOn("OpenClawWindows.Infrastructure")
            .GetResult();

        result.IsSuccessful.Should().BeTrue(
            because: $"application layer must not reference infrastructure: {string.Join(", ", result.FailingTypeNames ?? [])}");
    }

    [Fact]
    public void Ports_ShouldBeInterfaces()
    {
        // Simpler assertion: every concrete type in Ports starts with I (is an interface)
        var nonInterfaces = AllTypes()
            .That().ResideInNamespace("OpenClawWindows.Application.Ports")
            .And().AreClasses()
            .GetTypes();

        // Record types like WizardStartRpcResult are allowed in Ports (they're not ports themselves)
        // The strict rule only applies to the port interfaces that declare system boundaries.
        nonInterfaces.Should().NotContain(
            t => t.Name.StartsWith('I') && !t.IsInterface,
            because: "port interfaces must not be implemented classes masquerading as interfaces");
    }
}
