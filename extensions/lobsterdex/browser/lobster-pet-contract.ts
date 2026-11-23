import type { ThemeArtwork } from "@openclaw/gateway-protocol/theme";

export type LobsterPetMode = "idle" | "busy" | "offline";

export type LobsterRunOutcome = "ok" | "error" | "aborted";

// Renderers own the collision surfaces; the pet only measures their individual boxes.
export type LobsterComposerElements = {
  root: HTMLElement;
  composer: HTMLElement;
  editor: HTMLTextAreaElement;
  editorSurface: HTMLElement;
  footer: HTMLElement;
  controls: readonly HTMLElement[];
  obstacles: readonly HTMLElement[];
};

export type LobsterPetProps = {
  composerElements: (() => LobsterComposerElements | null) | undefined;
  seed: number;
  mode: LobsterPetMode;
  visitsEnabled: boolean;
  residentEnabled: boolean;
  critters: readonly string[] | undefined;
  critterArtwork: ThemeArtwork["critters"];
  floorEnabled: boolean;
  runOutcome: LobsterRunOutcome;
  soundsEnabled: boolean;
  gatewayVersion: string | null;
  onVisitsDisabled: () => void;
};
