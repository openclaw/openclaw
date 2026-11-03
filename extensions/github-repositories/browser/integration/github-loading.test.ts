import { expect, it } from "vitest";
import { useLazyEnglishTest } from "../../../../ui/src/i18n/lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each(["settings", "publication", "pull requests", "native hovercard"] as const)(
  "keeps English ownership and localized overrides at the cold %s boundary",
  async (surface) => {
    const { en, manager } = await loadI18n({
      githubConnections: { manage: "Verbindungen verwalten" },
      sessionHovercard: { checks: { passing: "CI-Prüfungen erfolgreich" } },
    });
    const t = manager.t.bind(manager);
    const connections = en.githubConnections;
    const publication = en.githubPublication;
    const requests = en.chat.pullRequests;
    const hovercard = en.sessionHovercard;
    const states = hovercard.states;
    const checks = hovercard.checks;
    expect(connections.manage).toBeUndefined();
    expect(publication.failedAttempt).toBeUndefined();
    expect(requests.publishPr).toBeUndefined();
    expect(hovercard.agentNotepad).toBeUndefined();
    expect(states.open).toBeUndefined();
    await manager.setLocale("de");
    const { registerControlUiEnglish } =
      await import("../../../../ui/src/plugins/control-ui-english.ts");
    const copy = await import("../../english-api.ts");
    const register = async () => {
      if (surface === "native hovercard") {
        await import("../../../../ui/src/i18n/locales/en-session-hovercard.ts").then(
          ({ registerSessionHovercardEnglish }) => registerSessionHovercardEnglish(),
        );
        return;
      }
      registerControlUiEnglish(
        surface === "settings"
          ? copy.settingsEnglish
          : surface === "publication"
            ? copy.publicationEnglish
            : copy.pullRequestEnglish,
      );
    };
    await register();
    expect(en.githubConnections).toBe(connections);
    expect(en.githubPublication).toBe(publication);
    expect(en.chat.pullRequests).toBe(requests);
    expect(en.sessionHovercard).toBe(hovercard);
    expect(hovercard.states).toBe(states);
    expect(hovercard.checks).toBe(checks);
    expect(t("githubConnections.manage")).toBe("Verbindungen verwalten");
    expect(t("sessionHovercard.checks.passing")).toBe("CI-Prüfungen erfolgreich");
    if (surface === "settings") {
      expect(connections.manage).toBe("Manage connections");
      expect(t("agentTools.githubVerify")).toBe("Verify");
      expect(publication.failedAttempt).toBeUndefined();
      expect(requests.publishPr).toBeUndefined();
      expect(hovercard.agentNotepad).toBeUndefined();
    } else if (surface === "publication") {
      expect(t("githubPublication.failedAttempt")).toBe("Publication attempt failed");
      expect(t("githubPublication.sharedUnavailable.changed")).toBe(
        "The Gateway GitHub account changed. Reload and retry publication.",
      );
      expect(connections.manage).toBeUndefined();
      expect(requests.publishPr).toBeUndefined();
    } else if (surface === "pull requests") {
      expect(t("chat.pullRequests.publishPr")).toBe("Publish PR");
      expect(t("chat.pullRequests.createPr")).toBe("Create PR");
      expect(t("chat.pullRequests.rateLimited")).toContain("GitHub API rate limit reached");
      expect(t("chat.pullRequests.checksPassed")).toBe("Passed");
      expect(t("sessionHovercard.states.open")).toBe("Open");
      expect(t("chat.pullRequests.automationAutoFix")).toBe("Auto-fix CI & address comments");
      expect(publication.failedAttempt).toBeUndefined();
      expect(connections.manage).toBeUndefined();
      expect(hovercard.agentNotepad).toBeUndefined();
    } else {
      expect(t("sessionHovercard.agentNotepad")).toBe("Task progress");
      expect(t("sessionHovercard.chatKinds.group")).toBe("Group chat");
      expect(t("sessionHovercard.viaAccount", { account: "work" })).toBe("Via work");
      expect(t("sessionHovercard.topicNumber", { id: "7" })).toBe("Topic 7");
      expect(states.open).toBeUndefined();
      expect(requests.publishPr).toBeUndefined();
      expect(connections.manage).toBeUndefined();
      expect(publication.failedAttempt).toBeUndefined();
    }
    // Repeated mounts are idempotent and retain translated overrides and object identity.
    await register();
    expect(en.githubPublication).toBe(publication);
    expect(en.chat.pullRequests).toBe(requests);
    expect(t("sessionHovercard.checks.passing")).toBe("CI-Prüfungen erfolgreich");
  },
);
