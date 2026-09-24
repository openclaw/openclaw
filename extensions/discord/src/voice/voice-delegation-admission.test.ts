import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createDiscordLivePolicyReader } from "../monitor/live-policy.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    agentCommandMock,
    controlRealtimeVoiceAgentRunMock,
    beginSpeakerTurn,
    configureVoiceStateGateway,
    createClient,
    createManager,
    createRuntime,
    getSessionEntry,
    getVoiceReceive,
    lastAgentCommandArgs,
    lastRealtimeBridgeParams,
    loggerWarnMock,
    makeVoiceConfig,
    managerModule,
    resolveConfiguredRealtimeVoiceProviderMock,
  }) => {
    it.each([
      { withSignal: true, revocation: "none" },
      { withSignal: true, revocation: "policy" },
      { withSignal: true, revocation: "role" },
      { withSignal: false, revocation: "none" },
      { withSignal: false, revocation: "policy" },
      { withSignal: false, revocation: "role" },
    ])(
      "uses current admission after native delegation roster lookup (signal=$withSignal, revocation=$revocation)",
      async ({ withSignal, revocation }) => {
        resolveConfiguredRealtimeVoiceProviderMock.mockReturnValue({
          provider: {
            id: "openai",
          },
          capabilities: { supportsActivationNameGating: false, handlesAgentConsult: true },
          providerConfig: { model: "gpt-live-1", voice: "marin" },
        });
        const discordConfig = makeVoiceConfig(
          { mode: "agent-proxy", realtime: { provider: "openai" } },
          {
            groupPolicy: "allowlist",
            guilds: { g1: { channels: { "1001": { roles: ["role:voice-role"] } } } },
          },
        );
        let cfg: OpenClawConfig = { channels: { discord: discordConfig } };
        const readPolicy = createDiscordLivePolicyReader({
          cfg,
          accountId: "default",
          token: "synthetic-token",
          readConfig: () => cfg,
        });
        const client = createClient();
        let speakerHasRole = true;
        const releaseRoster = createDeferred<void>();
        client.fetchMember.mockImplementation(async (_guildId: string, userId: string) => {
          if (userId === "444") {
            await releaseRoster.promise;
          }
          return {
            nickname: userId === "444" ? "Roster member" : "Current speaker",
            roles: userId === "333" && speakerHasRole ? ["voice-role"] : [],
            user: { id: userId, username: userId },
          };
        });
        const manager = new managerModule.DiscordVoiceManager({
          readPolicy,
          client: client as never,
          cfg,
          discordConfig,
          accountId: "default",
          runtime: createRuntime(),
        });
        agentCommandMock.mockResolvedValue({
          payloads: [{ text: "Authorized delegation completed." }],
        });
        try {
          expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({
            ok: true,
          });
          configureVoiceStateGateway(client, () => [
            { guild_id: "g1", channel_id: "1001", user_id: "444" },
          ]);
          beginSpeakerTurn(getSessionEntry(manager), {
            userId: "333",
            realAdmission: true,
            senderIsOwner: false,
            speakerLabel: "Previous label",
            extraSystemPrompt: "Previous turn context",
          }).close();
          const runner = lastRealtimeBridgeParams().runAgentConsult;
          expect(runner).toBeTypeOf("function");
          const delegation = runner!({
            prompt: "Check the current agenda",
            ...(withSignal ? { signal: new AbortController().signal } : {}),
          });
          const outcome = delegation.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          await vi.waitFor(() => expect(client.fetchMember).toHaveBeenCalledWith("g1", "444"));
          expect(agentCommandMock).not.toHaveBeenCalled();
          if (revocation === "policy") {
            cfg = { channels: { discord: { ...discordConfig, groupPolicy: "disabled" } } };
          } else if (revocation === "role") {
            speakerHasRole = false;
          }
          releaseRoster.resolve();
          const result = await outcome;
          if (revocation !== "none") {
            expect(result).toMatchObject({
              error: expect.objectContaining({
                message: expect.stringContaining("authorization changed"),
              }),
            });
            expect(agentCommandMock).not.toHaveBeenCalled();
          } else {
            expect(result).toEqual({ value: { text: "Authorized delegation completed." } });
            expect(agentCommandMock).toHaveBeenCalledOnce();
            expect(lastAgentCommandArgs()).toMatchObject({
              senderIsOwner: false,
              extraSystemPrompt: expect.stringContaining(
                'user_id="444" display_name="Roster member"',
              ),
            });
            expect(lastAgentCommandArgs().extraSystemPrompt).not.toContain("Previous turn context");
          }
        } finally {
          releaseRoster.resolve();
          await manager.destroy();
        }
      },
    );

    async function createRoleFixture(path: "forced" | "talkback") {
      const client = createClient();
      let roles = ["voice-role"];
      const member = () => ({
        nickname: "Role Speaker",
        roles,
        user: { id: "333", username: "speaker" },
      });
      client.fetchMember.mockImplementation(async () => member());
      const config = makeVoiceConfig(
        {
          mode: "agent-proxy",
          realtime: {
            provider: "openai",
            requireWakeName: false,
            toolPolicy: path === "forced" ? "owner" : "none",
            debounceMs: 200,
          },
        },
        {
          groupPolicy: "allowlist",
          guilds: {
            g1: {
              channels: {
                "1001": { roles: ["role:voice-role"], systemPrompt: "Fresh voice context." },
              },
            },
          },
        },
      );
      const manager = createManager(config, client, { channels: { discord: config } });
      expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({ ok: true });
      const entry = getSessionEntry(manager);
      const beginUtterance = async () => {
        const context = await getVoiceReceive(manager).resolveDiscordVoiceIngressContext(
          entry,
          "333",
        );
        if (!context) {
          throw new Error("Expected role admission");
        }
        beginSpeakerTurn(entry, { ...context, userId: "333", realAdmission: true }).close();
      };
      await beginUtterance();
      agentCommandMock.mockResolvedValue({ payloads: [{ text: "Current answer." }] });
      return {
        client,
        manager,
        member,
        beginUtterance,
        bridge: lastRealtimeBridgeParams(),
        setAllowed: (allowed: boolean) => {
          roles = allowed ? ["voice-role"] : [];
        },
      };
    }

    it.each(["forced", "talkback"] as const)(
      "does not revive a denied control transcript through %s fallback",
      async (path) => {
        const fixture = await createRoleFixture(path);
        vi.useFakeTimers();
        try {
          fixture.setAllowed(false);
          fixture.bridge.onTranscript?.("user", "stop using the slow path", true);
          await vi.advanceTimersByTimeAsync(0);
          expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
          expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.stringContaining("authorization changed"),
          );
          fixture.setAllowed(true);
          await vi.advanceTimersByTimeAsync(1_000);
          expect(agentCommandMock).not.toHaveBeenCalled();
          // A later, independently admitted utterance still reaches the agent.
          await fixture.beginUtterance();
          fixture.bridge.onTranscript?.("user", "Read the agenda", true);
          await vi.advanceTimersByTimeAsync(1_000);
          expect(agentCommandMock).toHaveBeenCalledOnce();
        } finally {
          await fixture.manager.destroy();
          vi.useRealTimers();
        }
      },
    );

    it.each(["forced", "talkback"] as const)(
      "retains authorized %s fallback after a control runtime error",
      async (path) => {
        const fixture = await createRoleFixture(path);
        controlRealtimeVoiceAgentRunMock.mockRejectedValueOnce(new Error("Control runtime failed"));
        vi.useFakeTimers();
        try {
          fixture.bridge.onTranscript?.("user", "stop using the slow path", true);
          await vi.advanceTimersByTimeAsync(1_000);
          expect(agentCommandMock).toHaveBeenCalledOnce();
          expect(lastAgentCommandArgs()).toMatchObject({ senderIsOwner: false });
        } finally {
          await fixture.manager.destroy();
          vi.useRealTimers();
        }
      },
    );

    it.each([
      { path: "forced", allowed: false },
      { path: "forced", allowed: true },
      { path: "talkback", allowed: false },
      { path: "talkback", allowed: true },
    ] as const)(
      "refreshes roles after $path dispatch is scheduled (allowed=$allowed)",
      async ({ path, allowed }) => {
        const fixture = await createRoleFixture(path);
        vi.useFakeTimers();
        try {
          fixture.bridge.onTranscript?.("user", "Read the agenda", true);
          await vi.advanceTimersByTimeAsync(0);
          expect(agentCommandMock).not.toHaveBeenCalled();
          fixture.setAllowed(allowed);
          await vi.advanceTimersByTimeAsync(1_000);
          if (allowed) {
            expect(agentCommandMock).toHaveBeenCalledOnce();
            expect(lastAgentCommandArgs()).toMatchObject({
              senderIsOwner: false,
              extraSystemPrompt: expect.stringContaining("Fresh voice context."),
            });
          } else {
            expect(agentCommandMock).not.toHaveBeenCalled();
          }
        } finally {
          await fixture.manager.destroy();
          vi.useRealTimers();
        }
      },
    );

    it("revokes delayed dispatch when the provider resets during admission", async () => {
      const fixture = await createRoleFixture("forced");
      const member = createDeferred<ReturnType<typeof fixture.member>>();
      let admissionPending = false;
      fixture.client.fetchMember.mockImplementation(async () => {
        admissionPending = true;
        return member.promise;
      });
      vi.useFakeTimers();
      try {
        fixture.bridge.onTranscript?.("user", "Read the agenda", true);
        await vi.advanceTimersByTimeAsync(250);
        expect(admissionPending).toBe(true);
        expect(agentCommandMock).not.toHaveBeenCalled();
        fixture.bridge.onEvent?.({ direction: "client", type: "session.continuity.reset" });
        member.resolve(fixture.member());
        await vi.advanceTimersByTimeAsync(0);
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        member.resolve(fixture.member());
        await fixture.manager.destroy();
        vi.useRealTimers();
      }
    });
  },
);
