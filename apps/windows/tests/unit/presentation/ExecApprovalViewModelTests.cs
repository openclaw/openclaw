namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class ExecApprovalViewModelTests
{
    [Fact]
    public void Ctor_SetsCommandText()
    {
        var vm = new ExecApprovalViewModel("bash -c 'echo hello'");
        Assert.Equal("bash -c 'echo hello'", vm.CommandText);
    }

    [Fact]
    public void HasSessionLabel_False_WhenNull()
    {
        var vm = new ExecApprovalViewModel("cmd", null);
        Assert.False(vm.HasSessionLabel);
    }

    [Fact]
    public void HasSessionLabel_False_WhenEmpty()
    {
        var vm = new ExecApprovalViewModel("cmd", "");
        Assert.False(vm.HasSessionLabel);
    }

    [Fact]
    public void HasSessionLabel_True_WhenProvided()
    {
        var vm = new ExecApprovalViewModel("cmd", "session-abc");
        Assert.True(vm.HasSessionLabel);
        Assert.Equal("session-abc", vm.SessionLabel);
    }
}
