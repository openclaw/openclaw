import { describe, expect, it } from "vitest";
import { withCurrentReplyIntegration } from "../../../test/helpers/agents/current-turn-delivery-integration.js";

describe("admitted host current reply through Slack transport", () => {
  it("rejects a foreign-session capability at the real host tool surface without effects", async () => {
    await withCurrentReplyIntegration(async (fixture) => {
      const turn = await fixture.createTurn();
      const original = fixture.readRow();
      expect(() => turn.createHostTool("foreign-session")).toThrow(
        "plugin delivery capability is no longer active",
      );
      await fixture.waitForSettled();
      expect(fixture.pendingToolExecutions()).toBe(0);
      expect(fixture.network.counts).toEqual({
        blocker: 0,
        route: 0,
        post: 0,
        "upload-url": 0,
        dns: 0,
        upload: 0,
        complete: 0,
      });
      expect(turn.completion()).toBeUndefined();
      expect(fixture.readRow()).toEqual(original);
    });
  });

  it("delivers after the same transport's held SDK admission opens", async () => {
    await withCurrentReplyIntegration(async (fixture) => {
      const turn = await fixture.createTurn();
      const tool = turn.createHostTool();
      const release = await fixture.occupyTransport();
      const admitted = fixture.observeSdkAdmission("allowed");
      const pending = fixture.track(
        turn.runWithHostScope(() => tool.execute("allowed", { text: "allowed" })),
      );
      await admitted();
      expect(fixture.network.counts.post).toBe(0);
      expect(turn.completion()).toBe("pending");
      release.resolve();
      await expect(pending).resolves.toMatchObject({
        details: { status: "sent" },
        terminate: true,
      });
      expect(fixture.network.counts.post).toBe(1);
      expect(turn.completion()).toBe("confirmed");
    });
  });

  it.each([
    "host closure",
    "authority release",
    "admission replacement",
    "writer",
    "lifecycle",
  ] as const)(
    "fences a queued physical request after %s without changing the successor row",
    async (revocation) => {
      await withCurrentReplyIntegration(async (fixture) => {
        const turn = await fixture.createTurn();
        const tool = turn.createHostTool();
        const release = await fixture.occupyTransport();
        const admitted = fixture.observeSdkAdmission("revoked");
        const pending = fixture.track(
          turn.runWithHostScope(() => tool.execute("revoked", { text: "revoked" })),
        );
        await admitted();
        expect(fixture.network.counts.post).toBe(0);
        expect(turn.completion()).toBe("pending");
        const originalRow = fixture.readRow();
        if (revocation === "host closure") {
          turn.closeHost();
        } else if (revocation === "authority release") {
          turn.releaseAuthority();
        } else if (revocation === "admission replacement") {
          await turn.replaceAdmission();
        } else if (revocation === "lifecycle") {
          const replaced = turn.replaceLifecycle();
          expect(replaced?.activeWriterRunId).toBe(originalRow?.activeWriterRunId);
          expect(replaced?.lifecycleRevision).not.toBe(originalRow?.lifecycleRevision);
        } else {
          turn.replaceWriter();
        }
        const successor = fixture.readRow();
        release.resolve();
        if (revocation === "writer" || revocation === "lifecycle") {
          await expect(pending).resolves.toMatchObject({ details: { status: "failed" } });
        } else {
          await expect(pending).rejects.toThrow();
        }
        await expect.poll(turn.completion).toBe("ambiguous");
        expect(fixture.network.counts).toMatchObject({ blocker: 100, post: 0 });
        expect(fixture.readRow()).toEqual(successor);
      });
    },
  );

  it("delivers a real local attachment through URL allocation, bytes, and completion", async () => {
    await withCurrentReplyIntegration(async (fixture) => {
      const turn = await fixture.createTurn();
      const mediaUrl = await fixture.state.writeText("media/current-reply.txt", "attachment");
      const tool = turn.createHostTool();
      await expect(
        fixture.track(
          turn.runWithHostScope(() =>
            tool.execute("upload-allowed", { text: "attachment", mediaUrl }),
          ),
        ),
      ).resolves.toMatchObject({ details: { status: "sent" }, terminate: true });
      expect(fixture.network.counts).toMatchObject({
        "upload-url": 1,
        dns: 1,
        upload: 1,
        complete: 1,
        post: 0,
      });
      expect(turn.completion()).toBe("confirmed");
    });
  });

  it.each(["upload-url", "dns", "upload"] as const)(
    "preserves accepted %s evidence but prevents every later upload stage after writer replacement",
    async (stage) => {
      await withCurrentReplyIntegration(async (fixture) => {
        const turn = await fixture.createTurn();
        const mediaUrl = await fixture.state.writeText("media/current-reply.txt", "attachment");
        const held = fixture.network.hold(stage);
        const tool = turn.createHostTool();
        const pending = fixture.track(
          turn.runWithHostScope(() =>
            tool.execute("upload-revoked", { text: "attachment", mediaUrl }),
          ),
        );
        await held.wait();
        expect(turn.completion()).toBe("pending");
        const successor = turn.replaceWriter();
        held.release.resolve();
        await expect(pending).resolves.toMatchObject({ details: { status: "failed" } });
        await expect.poll(turn.completion).toBe("ambiguous");
        expect(fixture.network.counts).toMatchObject({
          "upload-url": 1,
          dns: stage === "upload-url" ? 0 : 1,
          upload: stage === "upload" ? 1 : 0,
          complete: 0,
          post: 0,
        });
        expect(fixture.readRow()).toEqual(successor);
      });
    },
  );

  it.each(["accepted", "lost response"] as const)(
    "keeps a late %s receipt ambiguous after host closure and gives the next turn a new owner",
    async (acknowledgement) => {
      await withCurrentReplyIntegration(async (fixture) => {
        const turn = await fixture.createTurn();
        const tool = turn.createHostTool();
        const held = fixture.network.hold("post");
        if (acknowledgement === "lost response") {
          fixture.network.loseFirstPostResponse();
        }
        const pending = fixture.track(
          turn.runWithHostScope(() => tool.execute("late", { text: "late" })),
        );
        await held.wait();
        expect(fixture.pendingToolExecutions()).toBe(1);
        turn.closeHost();
        await expect(pending).rejects.toThrow();
        expect(fixture.pendingToolExecutions()).toBe(1);
        const joined = fixture.waitForSettled();
        held.release.resolve();
        await joined;
        expect(fixture.pendingToolExecutions()).toBe(0);
        await expect.poll(turn.completion).toBe("ambiguous");
        expect(fixture.network.counts.post).toBe(1);
        expect(() => turn.createHostTool()).toThrow();

        fixture.network.allowNextTurn();
        const next = await fixture.createTurn();
        const nextTool = next.createHostTool();
        await expect(
          fixture.track(
            next.runWithHostScope(() => nextTool.execute("next", { text: "next turn" })),
          ),
        ).resolves.toMatchObject({ details: { status: "sent" }, terminate: true });
        expect(next.completion()).toBe("confirmed");
        expect(turn.completion()).toBe("ambiguous");
        expect(fixture.network.counts.post).toBe(2);
      });
    },
  );

  it.each(["allowed", "revoked during preparation", "lost completion response"] as const)(
    "uses native HTTP and the real upload guard for %s",
    async (outcome) => {
      const nativeFetch = globalThis.fetch;
      await withCurrentReplyIntegration(
        async (fixture) => {
          expect(globalThis.fetch).toBe(nativeFetch);
          const turn = await fixture.createTurn();
          const attachment = "exact native upload bytes\n".repeat(32);
          const mediaUrl = await fixture.state.writeText("media/socket-proof.txt", attachment);
          const held =
            outcome === "revoked during preparation"
              ? fixture.network.hold("upload-url")
              : undefined;
          if (outcome === "lost completion response") {
            fixture.network.loseFirstCompletionResponse();
          }
          const tool = turn.createHostTool();
          const pending = fixture.track(
            turn.runWithHostScope(() =>
              tool.execute("socket-upload", { text: "socket attachment", mediaUrl }),
            ),
          );
          let successor = fixture.readRow();
          if (held) {
            await held.wait();
            expect(fixture.network.counts).toMatchObject({
              "upload-url": 1,
              upload: 0,
              complete: 0,
            });
            expect(turn.completion()).toBe("pending");
            successor = turn.replaceWriter();
            held.release.resolve();
          }
          const result = await pending;
          await fixture.waitForSettled();
          expect(fixture.pendingToolExecutions()).toBe(0);
          const requests = fixture.network.received;
          expect(requests.map((request) => request.stage)).toEqual(
            held ? ["upload-url"] : ["upload-url", "upload", "complete"],
          );
          const allocation = requests[0]!;
          expect(allocation.method).toBe("POST");
          expect(allocation.pathname).toBe("/api/files.getUploadURLExternal");
          expect(allocation.authorization).toMatch(/^Bearer xoxb-test-/);
          const allocationBody = new URLSearchParams(allocation.body.toString("utf8"));
          expect(allocationBody.get("filename")).toBe("socket-proof.txt");
          expect(allocationBody.get("length")).toBe(String(Buffer.byteLength(attachment)));
          if (held) {
            expect(result).toMatchObject({ details: { status: "failed" } });
            expect(turn.completion()).toBe("ambiguous");
            expect(fixture.readRow()).toEqual(successor);
            expect(fixture.network.counts).toMatchObject({
              "upload-url": 1,
              upload: 0,
              complete: 0,
              post: 0,
            });
            return;
          }
          const upload = requests[1]!;
          expect(upload.method).toBe("POST");
          expect(upload.pathname).toBe("/upload/current-reply");
          expect(upload.authorization).toBeUndefined();
          expect(upload.body).toEqual(Buffer.from(attachment));
          const completion = requests[2]!;
          expect(completion.method).toBe("POST");
          expect(completion.authorization).toBe(allocation.authorization);
          const completionBody = new URLSearchParams(completion.body.toString("utf8"));
          expect(completionBody.get("channel_id")).toBe("C12345678");
          expect(completionBody.get("initial_comment")).toBe("socket attachment");
          expect(JSON.parse(completionBody.get("files") ?? "null")).toEqual([
            { id: "F12345678", title: "socket-proof.txt" },
          ]);
          expect(fixture.network.counts).toMatchObject({
            "upload-url": 1,
            upload: 1,
            complete: 1,
            post: 0,
          });
          if (outcome === "allowed") {
            expect(result).toMatchObject({ details: { status: "sent" }, terminate: true });
            expect(turn.completion()).toBe("confirmed");
          } else {
            expect(result).toMatchObject({
              details: { status: "partial_failed", sentBeforeError: true },
              terminate: true,
            });
            expect(result.details).not.toHaveProperty("messageId");
            expect(turn.completion()).toBe("ambiguous");
            const reconstructed = turn.createHostTool();
            await expect(
              fixture.track(
                turn.runWithHostScope(() =>
                  reconstructed.execute("socket-retry", { text: "must not replay", mediaUrl }),
                ),
              ),
            ).rejects.toThrow("already been consumed");
            await fixture.waitForSettled();
            expect(fixture.network.received).toHaveLength(3);
            expect(fixture.network.counts.complete).toBe(1);
          }
        },
        { transport: "socket" },
      );
    },
  );
});
