/**
 * UIMockScene — Renders uiMock and uiMockMontage scene types.
 *
 * Maps uiPreset names to actual UI components:
 * - cutmv_configure_output_options_dark → ConfigureOutputCard
 * - cutmv_dashboard_outputs_dark → OutputCardStack (as status rows)
 * - cutmv_pricing_cards_dark → OutputCardStack (as feature cards)
 * - cutmv_output_cards_dark → OutputCardStack (as pack cards)
 * - cutmv_montage_dark → Sequenced cross-fade between two UI mocks
 */
import React from "react";
import { useCurrentFrame } from "remotion";
import {
  UIMockScene as UIMockSceneType,
  UIMockMontageScene,
} from "../parser/MotionSpecTypes";
import { SafeZone } from "../layout/SafeZone";
import { CutmvUIFrame } from "../ui/CutmvUIFrame";
import { ConfigureOutputCard } from "../ui/ConfigureOutputCard";
import { OutputCardStack } from "../ui/OutputCardStack";

const clamp = (n: number, a: number, b: number) =>
  Math.max(a, Math.min(b, n));

// ── Preset renderers ──
type PresetRenderer = (
  options: Record<string, unknown>,
  green: string,
) => React.ReactNode;

function renderConfigure(
  options: Record<string, unknown>,
  green: string,
): React.ReactNode {
  return (
    <CutmvUIFrame green={green}>
      <ConfigureOutputCard
        green={green}
        title={(options.title as string) ?? "CONFIGURE OUTPUT OPTIONS"}
        quickStart={true}
        aspectPills={
          (options.aspectToggles as string[]) ?? ["9:16", "1:1", "16:9"]
        }
        toggles={
          (options.outputs as string[]) ?? [
            "CLIPS",
            "GIFS",
            "THUMBNAILS",
            "CANVAS",
          ]
        }
        cta={(options.primaryButton as string) ?? "START CREATING NOW"}
      />
    </CutmvUIFrame>
  );
}

function renderDashboard(
  options: Record<string, unknown>,
  green: string,
): React.ReactNode {
  const rows = (options.rows as { label: string; status: string }[]) ?? [];
  const cards = rows.map((r) => ({
    label: r.label,
    credits: r.status === "READY" ? 180 : 0,
  }));
  return <OutputCardStack green={green} cards={cards} />;
}

function renderCards(
  options: Record<string, unknown>,
  green: string,
): React.ReactNode {
  const rawCards =
    (options.cards as { title: string; meta?: string; badge?: string }[]) ?? [];
  const cards = rawCards.map((c) => ({
    label: c.title,
    credits: 180,
  }));
  return <OutputCardStack green={green} cards={cards} />;
}

// ── Exact preset → renderer map (strict routing — checked first) ──
const EXACT_PRESET_MAP: Record<string, PresetRenderer> = {
  cutmv_configure_output_options_dark: renderConfigure,
  cutmv_dashboard_outputs_dark: renderDashboard,
  cutmv_pricing_cards_dark: renderCards,
  cutmv_output_cards_dark: renderCards,
  cutmv_montage_dark: renderConfigure,
};

// ── Fuzzy fallback rules (only used when exact match misses) ──
const FUZZY_RULES: { test: (p: string) => boolean; renderer: PresetRenderer }[] = [
  { test: (p) => p.includes("configure"), renderer: renderConfigure },
  { test: (p) => p.includes("dashboard"), renderer: renderDashboard },
  { test: (p) => p.includes("cards") || p.includes("pricing"), renderer: renderCards },
];

// ── Preset → Component mapper (exported for element-based rendering) ──
export function renderUIPreset(
  preset: string,
  options: Record<string, unknown>,
  green: string,
): React.ReactNode {
  // 1. Exact match (fast path — no ambiguity)
  const exact = EXACT_PRESET_MAP[preset];
  if (exact) return exact(options, green);

  // 2. Fuzzy fallback (legacy/forward compat)
  for (const rule of FUZZY_RULES) {
    if (rule.test(preset)) {
      console.warn(
        `[renderUIPreset] fuzzy match for "${preset}" — consider using an exact preset name`,
      );
      return rule.renderer(options, green);
    }
  }

  // 3. Ultimate fallback: configure card
  console.warn(
    `[renderUIPreset] unknown preset "${preset}" — falling back to configure card`,
  );
  return renderConfigure(options, green);
}

export const UIMockRenderer: React.FC<{
  scene: UIMockSceneType;
  green: string;
}> = ({ scene, green }) => {
  const frame = useCurrentFrame();
  const headlineTop = scene.layout?.headlineTop;

  // Entrance animation
  const t = clamp(frame / 16, 0, 1);
  const ease = 1 - Math.pow(1 - t, 3);

  return (
    <SafeZone>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
        }}
      >
        {/* Top headline (if specified) */}
        {headlineTop ? (
          <div
            style={{
              fontSize: 48,
              fontWeight: 1000,
              color: "white",
              textAlign: "center",
              opacity: ease,
            }}
          >
            {headlineTop.text}
            {headlineTop.underline ? (
              <div
                style={{
                  margin: "8px auto 0",
                  width: 400,
                  height: 5,
                  background: green,
                  borderRadius: 999,
                  transform: `scaleX(${ease})`,
                  transformOrigin: "left",
                }}
              />
            ) : null}
          </div>
        ) : null}

        {/* UI Component */}
        <div
          style={{
            opacity: ease,
            transform: `translateY(${(1 - ease) * 30}px) scale(${0.96 + ease * 0.04})`,
          }}
        >
          {renderUIPreset(scene.uiPreset, scene.uiOptions, green)}
        </div>
      </div>
    </SafeZone>
  );
};

export const UIMockMontageRenderer: React.FC<{
  scene: UIMockMontageScene;
  green: string;
}> = ({ scene, green }) => {
  const frame = useCurrentFrame();
  const headlineTop = scene.layout?.headlineTop;
  const modules = scene.uiOptions.modules ?? [];

  // Determine which module to show based on frame progress
  const progress = frame / scene.duration;
  let cumWeight = 0;
  let activePreset = modules[0]?.preset ?? "cutmv_configure_output_options_dark";
  for (const mod of modules) {
    cumWeight += mod.weight;
    if (progress < cumWeight) {
      activePreset = mod.preset;
      break;
    }
    activePreset = mod.preset;
  }

  const t = clamp(frame / 16, 0, 1);
  const ease = 1 - Math.pow(1 - t, 3);

  return (
    <SafeZone>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
        }}
      >
        {headlineTop ? (
          <div
            style={{
              fontSize: 48,
              fontWeight: 1000,
              color: "white",
              textAlign: "center",
              opacity: ease,
            }}
          >
            {headlineTop.text}
            {headlineTop.underline ? (
              <div
                style={{
                  margin: "8px auto 0",
                  width: 400,
                  height: 5,
                  background: green,
                  borderRadius: 999,
                }}
              />
            ) : null}
          </div>
        ) : null}

        <div
          style={{
            opacity: ease,
            transform: `translateY(${(1 - ease) * 30}px)`,
          }}
        >
          {renderUIPreset(activePreset, scene.uiOptions, green)}
        </div>
      </div>
    </SafeZone>
  );
};
