// Property-Based Tests generated from pbt_properties.yaml (Phase 3 Step 2)
// Tool: FsCheck 2.x + FsCheck.Xunit
// Properties: PBT-001..PBT-010 covering domain invariants

using OpenClawWindows.Domain.Gateway.Events;

namespace OpenClawWindows.Tests.Pbt;

// ── PBT Configuration ────────────────────────────────────────────────────────

public static class FsCheckProfiles
{
    // CI profile: reduced iterations for speed
    public static Configuration CI => new() { MaxNbOfTest = 50, EndSize = 100 };

    public static Configuration Dev => new() { MaxNbOfTest = 200, EndSize = 200 };

    public static Configuration Current =>
        Environment.GetEnvironmentVariable("FSCHECK_PROFILE") switch
        {
            "ci"  => CI,
            "dev" => Dev,
            _     => Dev
        };
}

// ── Generators ───────────────────────────────────────────────────────────────

public static class DomainGenerators
{
    public static Arbitrary<int> ValidScreenDurationMsArb() =>
        Gen.Choose(RateLimit.ScreenRecordMinDurationMs, RateLimit.ScreenRecordMaxDurationMs)
            .ToArbitrary();

    public static Arbitrary<int> InvalidScreenDurationMsArb() =>
        Gen.OneOf(
            Gen.Choose(0, RateLimit.ScreenRecordMinDurationMs - 1),
            Gen.Choose(RateLimit.ScreenRecordMaxDurationMs + 1, 300_000))
        .ToArbitrary();

    public static Arbitrary<int> ValidFpsArb() =>
        Gen.Choose(RateLimit.ScreenRecordMinFps, RateLimit.ScreenRecordMaxFps)
            .ToArbitrary();

    public static Arbitrary<string> ValidWsUriArb() =>
        (from host in Gen.Elements("localhost", "192.168.1.1", "gateway.local")
         from port in Gen.Choose(1024, 65535)
         from scheme in Gen.Elements("ws", "wss")
         select $"{scheme}://{host}:{port}")
        .ToArbitrary();

    public static Arbitrary<string> InvalidSchemeUriArb() =>
        Gen.Elements(
            "http://localhost:8080",
            "https://gateway.local",
            "ftp://host:21",
            "localhost:8080",
            "not_a_url")
        .ToArbitrary();
}

// ── PBT-001 / PBT-002: Entity domain events ─────────────────────────────────

public sealed class EntityDomainEventProperties
{
    // PBT-001: Adding a domain event always increments count
    [Property]
    public Property Entity_AddDomainEvent_AlwaysIncrementsCount()
    {
        return Prop.ForAll(
            Gen.Constant(0).ToArbitrary(),  // placeholder — event count starts at 0
            _ =>
            {
                var conn = GatewayConnection.Create("openclaw-control-ui");
                var before = conn.DomainEvents.Count;
                conn.MarkConnecting();
                return conn.DomainEvents.Count == before + 1;
            });
    }

    // PBT-002: ClearDomainEvents always results in empty list
    [Property]
    public Property Entity_ClearDomainEvents_AlwaysResultsInEmpty()
    {
        return Prop.ForAll(
            Arb.Default.PositiveInt(),
            count =>
            {
                var conn = GatewayConnection.Create("openclaw-control-ui");
                // Add events via state transitions
                var n = Math.Min(count.Get % 5, 2); // at most 2 cycles
                for (int i = 0; i < n; i++)
                {
                    conn.MarkConnecting();
                    conn.MarkDisconnected("test");
                }
                conn.ClearDomainEvents();
                return conn.DomainEvents.Count == 0;
            });
    }
}

// ── PBT-004 / PBT-005: CaptureRateLimits duration boundaries ────────────────

public sealed class CaptureDurationProperties
{
    // PBT-004: Any valid screen.record duration is accepted by ScreenRecordingParams
    [Property]
    public Property ScreenRecord_ValidDuration_AlwaysAccepted()
    {
        return Prop.ForAll(
            DomainGenerators.ValidScreenDurationMsArb(),
            durationMs =>
            {
                var json = $"{{\"durationMs\":{durationMs}}}";
                var result = ScreenRecordingParams.FromJson(json);
                return result.IsError == false;
            });
    }

    // PBT-005: Out-of-range durations are always rejected
    [Property]
    public Property ScreenRecord_InvalidDuration_AlwaysRejected()
    {
        return Prop.ForAll(
            DomainGenerators.InvalidScreenDurationMsArb(),
            durationMs =>
            {
                var json = $"{{\"durationMs\":{durationMs}}}";
                var result = ScreenRecordingParams.FromJson(json);
                return result.IsError == true;
            });
    }

    // PBT-006: Valid FPS values are always accepted
    [Property]
    public Property ScreenRecord_ValidFps_AlwaysAccepted()
    {
        return Prop.ForAll(
            DomainGenerators.ValidFpsArb(),
            fps =>
            {
                var json = $"{{\"fps\":{fps}}}";
                var result = ScreenRecordingParams.FromJson(json);
                return result.IsError == false;
            });
    }
}

// ── PBT-007 / PBT-008: GatewayEndpoint URL validation ───────────────────────

public sealed class GatewayEndpointProperties
{
    // PBT-007: Valid ws/wss URLs always succeed
    [Property]
    public Property GatewayEndpoint_ValidWsUrl_CreateSucceeds()
    {
        return Prop.ForAll(
            DomainGenerators.ValidWsUriArb(),
            url =>
            {
                var result = GatewayEndpoint.Create(url, "test");
                return result.IsError == false;
            });
    }

    // PBT-008: Invalid schemes always fail
    [Property]
    public Property GatewayEndpoint_InvalidScheme_CreateFails()
    {
        return Prop.ForAll(
            DomainGenerators.InvalidSchemeUriArb(),
            url =>
            {
                var result = GatewayEndpoint.Create(url, "test");
                return result.IsError == true;
            });
    }
}

// ── PBT-009: ExecApprovalSession state machine ───────────────────────────────

public sealed class ExecApprovalStateMachineProperties
{
    // Execution can only happen after approval — invariant from ExecApprovalEvaluation.swift
    [Property]
    public Property ExecApproval_ExecutionRequiresApproval_Always()
    {
        return Prop.ForAll(
            Arb.Default.Bool(),  // whether approval was given
            approved =>
            {
                var session = ExecApprovalSession.Create(ExecApprovalConfig.AllowAll());
                session.RequestApproval("{\"executable\":\"ls\"}", "c1");

                if (approved)
                    session.Approve();
                else
                    session.Deny();

                var execResult = session.BeginExecution();

                // BeginExecution succeeds iff state == Approved
                return approved
                    ? execResult.IsError == false
                    : execResult.IsError == true;
            });
    }
}

// ── PBT-010: CameraSession busy state invariant ──────────────────────────────

public sealed class CameraSessionProperties
{
    [Property]
    public Property CameraSession_OnlyOneCapture_AtATime()
    {
        return Prop.ForAll(
            Arb.Default.PositiveInt(),
            _ =>
            {
                var session = CameraSession.Create("cam-0");
                session.BeginPhotoCapture();

                // Cannot start another capture while busy
                var threw = false;
                try { session.BeginPhotoCapture(); }
                catch (InvalidOperationException) { threw = true; }

                return threw;
            });
    }
}
