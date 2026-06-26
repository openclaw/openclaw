#!/usr/bin/env node
import { runMode } from "./lib/snes-toolchain.mjs";

function parseArgs(argv) {
  const modes = [
    "probe",
    "install",
    "conversion-smoke",
    "rom-smoke",
    "emulator-smoke",
    "reconcile-production-state",
    "visual-reject",
    "project-art-bible",
    "project-art-source-pack",
    "project-art-manifest",
    "project-art-compile",
    "project-audio-compile",
    "project-conversion",
    "project-visual-proof",
    "project-visual-quality-audit",
    "project-runtime-asset-truth",
    "project-visual-review-pack",
    "project-visual-approval",
    "project-browser-playtest",
    "project-rom",
    "project-engine-rom",
    "project-emulator",
    "project-engine-emulator",
    "fxpak-dry-run",
    "fxpak-transfer-package",
    "fxpak-copy",
  ];
  const args = {
    allowFxpakWrite: false,
    artifactDir: undefined,
    confirmFxpakVolume: undefined,
    fxpakVolume: undefined,
    json: false,
    mode: "probe",
    projectId: undefined,
    levelId: undefined,
    assetId: undefined,
    approver: undefined,
    humanScore: undefined,
    confirmHumanReviewedVisuals: false,
    reviewNote: undefined,
    proofSource: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (modes.includes(arg)) {
      args.mode = arg;
    } else if (arg === "--artifact-dir") {
      args.artifactDir = argv[++index];
    } else if (arg === "--project-id") {
      args.projectId = argv[++index];
    } else if (arg === "--level-id") {
      args.levelId = argv[++index];
    } else if (arg === "--asset-id") {
      args.assetId = argv[++index];
    } else if (arg === "--approver") {
      args.approver = argv[++index];
    } else if (arg === "--human-score") {
      args.humanScore = argv[++index];
    } else if (arg === "--confirm-human-reviewed-visuals") {
      args.confirmHumanReviewedVisuals = true;
    } else if (arg === "--review-note") {
      args.reviewNote = argv[++index];
    } else if (arg === "--proof-source") {
      args.proofSource = argv[++index];
    } else if (arg === "--fxpak-volume") {
      args.fxpakVolume = argv[++index];
    } else if (arg === "--confirm-fxpak-volume") {
      args.confirmFxpakVolume = argv[++index];
    } else if (arg === "--allow-fxpak-write") {
      args.allowFxpakWrite = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(
    [
      "Usage: pnpm snes:toolchain -- probe --json",
      "       pnpm snes:toolchain -- install --json",
      "       pnpm snes:toolchain -- conversion-smoke --json",
      "       pnpm snes:toolchain -- rom-smoke --json",
      "       pnpm snes:toolchain -- emulator-smoke --json",
      "       pnpm snes:toolchain -- reconcile-production-state --project-id stanskis-world --json",
      "       pnpm snes:toolchain -- visual-reject --project-id stanskis-world --level-id w1-1-cleveland-skyline-scramble --human-score 3 --json",
      "       pnpm snes:toolchain -- project-art-bible --project-id stanskis-world --level-id w1-1-cleveland-skyline-scramble --json",
      "       pnpm snes:toolchain -- project-art-source-pack --project-id stanskis-world --level-id w1-1-cleveland-skyline-scramble --json",
      "       pnpm snes:toolchain -- project-art-manifest --project-id comet-fox-mvp --asset-id hero --json",
      "       pnpm snes:toolchain -- project-art-compile --project-id comet-fox-mvp --json",
      "       pnpm snes:toolchain -- project-audio-compile --project-id stanskis-world --json",
      "       pnpm snes:toolchain -- project-conversion --project-id comet-fox-mvp --json",
      "       pnpm snes:toolchain -- project-visual-proof --project-id comet-fox-mvp --json",
      "       pnpm snes:toolchain -- project-visual-quality-audit --project-id stanskis-world --json",
      "       pnpm snes:toolchain -- project-runtime-asset-truth --project-id stanskis-world --json",
      "       pnpm snes:toolchain -- project-visual-review-pack --project-id comet-fox-mvp --level-id level-1 --json",
      '       pnpm snes:toolchain -- project-visual-approval --project-id comet-fox-mvp --human-score 100 --confirm-human-reviewed-visuals --approver human-operator --review-note "reviewed contact sheets and in-game screenshots" --json',
      "       pnpm snes:toolchain -- project-browser-playtest --project-id stanskis-world --level-id w1-1-cleveland-skyline-scramble --json",
      "       pnpm snes:toolchain -- project-rom --project-id comet-fox-mvp --json",
      "       pnpm snes:toolchain -- project-engine-rom --project-id comet-fox-mvp --json",
      "       pnpm snes:toolchain -- project-emulator --project-id comet-fox-mvp --json",
      "       pnpm snes:toolchain -- project-engine-emulator --project-id comet-fox-mvp --json",
      "       pnpm snes:toolchain -- fxpak-dry-run --project-id comet-fox-mvp --fxpak-volume /Volumes/FXPAK --json",
      "       pnpm snes:toolchain -- fxpak-transfer-package --project-id stanskis-world --json",
      "       pnpm snes:toolchain -- fxpak-copy --project-id comet-fox-mvp --fxpak-volume /Volumes/FXPAK --confirm-fxpak-volume /Volumes/FXPAK --allow-fxpak-write --json",
      "",
      "Installs/probes only free local SNES production tools approved for SNES Studio.",
      "FXPAK copy requires exact volume confirmation and --allow-fxpak-write; no SRAM writes, no overwrites, no directory creation on media.",
      "Never uses hosted GLM/GPT.",
    ].join("\n"),
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

try {
  const report = runMode(args.mode, {
    allowFxpakWrite: args.allowFxpakWrite,
    artifactDir: args.artifactDir,
    assetId: args.assetId,
    confirmFxpakVolume: args.confirmFxpakVolume,
    fxpakVolume: args.fxpakVolume,
    humanScore: args.humanScore,
    levelId: args.levelId,
    approver: args.approver,
    confirmHumanReviewedVisuals: args.confirmHumanReviewedVisuals,
    projectId: args.projectId,
    proofSource: args.proofSource,
    reviewNote: args.reviewNote,
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`SNES toolchain ${args.mode}: ${report.status}`);
    if (report.artifacts?.receiptPath) console.log(`Receipt: ${report.artifacts.receiptPath}`);
    if (report.blockers?.length) console.log(`Blocker: ${report.blockers[0]}`);
    if (report.probe?.blockers?.length) console.log(`Blocker: ${report.probe.blockers[0]}`);
  }
  const proofMode = [
    "conversion-smoke",
    "rom-smoke",
    "emulator-smoke",
    "reconcile-production-state",
    "visual-reject",
    "project-art-bible",
    "project-art-source-pack",
    "project-art-manifest",
    "project-art-compile",
    "project-audio-compile",
    "project-conversion",
    "project-visual-proof",
    "project-visual-quality-audit",
    "project-runtime-asset-truth",
    "project-visual-review-pack",
    "project-visual-approval",
    "project-browser-playtest",
    "project-rom",
    "project-engine-rom",
    "project-emulator",
    "project-engine-emulator",
    "fxpak-dry-run",
    "fxpak-transfer-package",
    "fxpak-copy",
  ].includes(args.mode);
  const successfulNonPassReceipt = args.mode === "visual-reject" && report.status === "rejected";
  process.exit(proofMode && report.status !== "pass" && !successfulNonPassReceipt ? 2 : 0);
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  if (args.json) {
    console.log(JSON.stringify({ status: "error", error: message }, null, 2));
  } else {
    console.error(message);
  }
  process.exit(1);
}
