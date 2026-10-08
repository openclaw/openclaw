// OpenClawTests is hosted by the real OpenClaw app (apps/ios/project.yml).
// Its startup reaches RootTabs, onboarding/settings, and NodeAppModel services.
// The voice group's typography suite also reads every app/Watch Swift source.
const sharedOwners = [
  /^apps\/ios\/Sources\//u,
  /^apps\/ios\/Resources\//u,
  /^apps\/shared\/OpenClawKit\/Sources\//u,
  /^apps\/swabble\/Sources\/SwabbleKit\//u,
  /^apps\/shared\/mermaid\//u,
  /^packages\/mermaid-renderer\//u,
  /^apps\/ios\/(?:project\.yml|[^/]+\.plist|[^/]+\.xcconfig|Config\/|Tests\/Info\.plist)/u,
  /^apps\/(?:shared\/OpenClawKit|swabble)\/Package\.(?:swift|resolved)$/u,
  /^apps\/macos\/Tests\/OpenClawIPCTests\/(?:AsyncTestGate|DashboardHTTPFixture|GatewayWebSocketTestSupport|TestWait)\.swift$/u,
  /^apps\/shared\/OpenClawKit\/Tests\/OpenClawKitTests\/(?:NativeGatewayWebSocketFixture|ChatMermaidRenderModelTests|ChatSelectableTextViewTests|ChatPasteboardTests)\.swift$/u,
];

const buildOwners = [
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/u,
  /^\.github\/(?:workflows\/ci\.yml|actions\/)/u,
  /^config\/swift(?:lint\.yml|format)$/u,
  /^scripts\/(?:ci-build-manifest\.mjs|ci-changed-scope\.mjs|prepare-apple-mermaid\.mjs|select-ios-simulator\.mjs)$/u,
  /^scripts\/ci-xcodebuild\.py$/u,
  /^scripts\/lib\/(?:ci-ios-smoke-plan\.mjs|swift-toolchain\.sh|(?:ios|mobile)-version\.ts|release-version\.mjs|version-script-args\.ts)$/u,
  /^scripts\/(?:check-swift-tools|format-swift|install-simslim|install-swift-tools|install-xcodegen|lint-swift|ios-configure-signing|ios-generate-test-tls-identity|ios-simulator-prepare|ios-team-id|ios-write-version-xcconfig)\.sh$/u,
  /^scripts\/(?:ios-write-swift-filelist\.m[jt]s|ios-version\.ts)$/u,
];

const voiceOwners = [
  /^apps\/ios\/WatchApp\/(?:Sources\/|Info\.plist$)/u,
  /^apps\/ios\/ActivityWidget\//u,
  /^apps\/ios\/Tests\/(?:TalkRealtimeVoiceSessionCleanupTests|TalkRealtimeConsultCancellationTests|TalkRealtimeTranscriptWriteQueueTests|TalkModeConfigParsingTests|ManagedDocumentEnvelopeTests|IOSMediaArtifactLoaderTests|OpenClawTypographyTests)\.swift$/u,
  /^apps\/ios\/Tests\/Fixtures\/managed-document-message\.json$/u,
];

const lifecycleOwners = [
  /^apps\/ios\/Tests\/(?:CloudflareAccessClientTests|CloudflareAccessTransferTests|CloudflareAccessSessionStoreTests|CloudflareAccessTestTokens|ChatTypingFocusTests|ChatSendHydrationTests|GatewayIngressControllerTests|GatewayConnectionControllerTests|GatewayConnectionSecurityTests|GatewaySettingsStoreTests)\.swift$/u,
];

/** Select simulator execution only; the app and test products still compile. */
export function resolveIosSimulatorTestSelection(
  changedPaths,
  { enabled = true, forceFull = false, fullReason = "full validation" } = {},
) {
  const selection = (mode, voice, lifecycle) => ({
    mode,
    voice: { selected: enabled && voice.length > 0, reasons: voice },
    lifecycle: { selected: enabled && lifecycle.length > 0, reasons: lifecycle },
  });
  if (!enabled) {
    return selection("not-selected", ["iOS job not selected"], ["iOS job not selected"]);
  }
  if (forceFull) {
    return selection("full", [fullReason], [fullReason]);
  }
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.some(
      (file) =>
        typeof file !== "string" ||
        !file ||
        file.startsWith("/") ||
        file.split("/").some((part) => part === "." || part === "..") ||
        /[\\\r\n\0]/u.test(file),
    )
  ) {
    return selection(
      "full",
      ["changed paths unavailable or invalid"],
      ["changed paths unavailable or invalid"],
    );
  }
  const voice = [];
  const lifecycle = [];
  for (const file of [...new Set(changedPaths)].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (buildOwners.some((pattern) => pattern.test(file))) {
      return selection("full", [`build/test input: ${file}`], [`build/test input: ${file}`]);
    }
    if (sharedOwners.some((pattern) => pattern.test(file))) {
      voice.push(`shared app/test owner: ${file}`);
      lifecycle.push(`shared app/test owner: ${file}`);
      continue;
    }
    if (voiceOwners.some((pattern) => pattern.test(file))) {
      voice.push(`voice/media/typography owner: ${file}`);
    }
    if (lifecycleOwners.some((pattern) => pattern.test(file))) {
      lifecycle.push(`Access/chat lifecycle owner: ${file}`);
    }
  }
  return selection("changed-owners", voice, lifecycle);
}

export function formatIosSimulatorSelectionSummary(selection) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replace(/[\\`*_{}[\]()#+.!|]/gu, "\\$&")
      .replace(/[\r\n]/gu, " ");
  return (
    "### iOS simulator test selection\n\n" +
    `- Mode: ${escape(selection.mode)}.\n` +
    "- App and test-bundle compilation remain required when the iOS job is selected.\n\n" +
    "| Group | Run | Reasons |\n| --- | --- | --- |\n" +
    ["voice", "lifecycle"]
      .map((group) => {
        const { selected, reasons } = selection[group];
        const why = reasons.length ? reasons.map(escape).join("; ") : "No changed owner";
        return `| ${group} | ${selected ? "yes" : "no"} | ${why} |\n`;
      })
      .join("") +
    "\n"
  );
}
