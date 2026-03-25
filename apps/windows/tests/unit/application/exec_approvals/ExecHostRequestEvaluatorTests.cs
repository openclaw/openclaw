using OpenClawWindows.Application.ExecApprovals;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Tests.Unit.Application.ExecApprovals;

// Mirrors ExecHostRequestEvaluatorTests.swift — same 4 test scenarios.
public sealed class ExecHostRequestEvaluatorTests
{
    [Fact]
    public void ValidateRequest_EmptyCommand_ReturnsInvalidRequest()
    {
        var request = new ExecHostRequest
        {
            Command    = [],
            RawCommand = null,
        };

        var result = ExecHostRequestEvaluator.ValidateRequest(request);

        var failed = Assert.IsType<ExecHostValidateResult.Failed>(result);
        Assert.Equal("INVALID_REQUEST", failed.Error.Code);
        Assert.Equal("command required", failed.Error.Message);
    }

    [Fact]
    public void Evaluate_AllowlistMissNoDecision_RequiresPrompt()
    {
        var context = MakeContext(
            security:          ExecSecurity.Allowlist,
            ask:               ExecAsk.OnMiss,
            allowlistSatisfied: false,
            skillAllow:        false);

        var decision = ExecHostRequestEvaluator.Evaluate(context, approvalDecision: null);

        Assert.IsType<ExecHostPolicyDecision.RequiresPrompt>(decision);
    }

    [Fact]
    public void Evaluate_AllowOnceDecisionOnAllowlistMiss_AllowsWithApprovedByAsk()
    {
        var context = MakeContext(
            security:          ExecSecurity.Allowlist,
            ask:               ExecAsk.OnMiss,
            allowlistSatisfied: false,
            skillAllow:        false);

        var decision = ExecHostRequestEvaluator.Evaluate(context, approvalDecision: ExecApprovalDecision.AllowOnce);

        var allow = Assert.IsType<ExecHostPolicyDecision.Allow>(decision);
        Assert.True(allow.ApprovedByAsk);
    }

    [Fact]
    public void Evaluate_ExplicitDenyDecision_DeniesWithUserDeniedReason()
    {
        var context = MakeContext(
            security:          ExecSecurity.Full,
            ask:               ExecAsk.Off,
            allowlistSatisfied: true,
            skillAllow:        false);

        var decision = ExecHostRequestEvaluator.Evaluate(context, approvalDecision: ExecApprovalDecision.Deny);

        var deny = Assert.IsType<ExecHostPolicyDecision.Deny>(decision);
        Assert.Equal("user-denied", deny.Error.Reason);
    }

    private static ExecApprovalEvaluation MakeContext(
        ExecSecurity security,
        ExecAsk ask,
        bool allowlistSatisfied,
        bool skillAllow) => new()
    {
        Command              = ["/usr/bin/echo", "hi"],
        DisplayCommand       = "/usr/bin/echo hi",
        AgentId              = null,
        Security             = security,
        Ask                  = ask,
        Env                  = new Dictionary<string, string>(),
        Resolution           = null,
        AllowlistResolutions = [],
        AllowlistMatches     = [],
        AllowlistSatisfied   = allowlistSatisfied,
        AllowlistMatch       = null,
        SkillAllow           = skillAllow,
    };
}
