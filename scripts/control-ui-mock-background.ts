import type { BackgroundPreference } from "../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { ThemesSetParams } from "../packages/gateway-protocol/src/schema/themes.ts";
import type {
  UserBackgroundAsset,
  UsersBackgroundUploadParams,
} from "../packages/gateway-protocol/src/schema/users-background.ts";
import { BUILTIN_THEMES, type ThemeDescriptor } from "../packages/gateway-protocol/src/theme.ts";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

/** Page-lifetime mock data only; rendering and all Appearance controls are the real UI. */
function installBackgroundMock(themes: readonly ThemeDescriptor[]): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  const query = new URLSearchParams(location.search);
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1000;
  const pixels = canvas.getContext("2d")!;
  for (let y = 0; y < canvas.height; y += 48) {
    for (let x = 0; x < canvas.width; x += 48) {
      pixels.fillStyle = (x / 48 + y / 48) % 2 ? "#ffff00" : "#000000";
      pixels.fillRect(x, y, 48, 48);
    }
  }
  const jpeg = (value: string) =>
    new Blob([Uint8Array.from(atob(value), (c) => c.charCodeAt(0))], { type: "image/jpeg" });
  let image = jpeg(canvas.toDataURL("image/jpeg").split(",")[1]!);
  let asset: UserBackgroundAsset | null = {
    assetId: "mock-checker",
    width: 1600,
    height: 1000,
    byteLength: image.size,
    mime: "image/jpeg",
  };
  const entries: Record<string, unknown> = {
    "ui.theme": "claw",
    "ui.themeMode": query.get("mode") === "light" ? "light" : "dark",
    "ui.background": {
      source: { kind: "custom", assetId: asset.assetId },
      presentation: query.get("presentation") === "full-bleed" ? "full-bleed" : "faded",
      showOnNewSession: true,
      showInSessions: true,
      visibility: 1,
    } satisfies BackgroundPreference,
  };
  const selection = (id = entries["ui.theme"] ?? "claw") => ({
    current: {
      id: entries["ui.theme"] ?? "claw",
      mode: entries["ui.themeMode"] ?? "system",
      scope: "profile",
      overrides: {
        ...(entries["ui.theme"] ? { id: entries["ui.theme"] } : {}),
        ...(entries["ui.themeMode"] ? { mode: entries["ui.themeMode"] } : {}),
      },
    },
    theme: themes.find((theme) => theme.id === id) ?? themes[0],
  });
  gateway.setRequestHandler("themes.list", ({ respond }) => respond({ ...selection(), themes }));
  gateway.setRequestHandler("themes.get", ({ params, respond }) => {
    const input = params as { id?: string };
    respond(selection(input.id));
  });
  gateway.setRequestHandler("themes.set", ({ params, respond }) => {
    const input = params as ThemesSetParams;
    if (input.id != null && !themes.some((theme) => theme.id === input.id)) {
      respond({
        __mockError: { code: "INVALID_REQUEST", message: "Choose a built-in fixture theme." },
      });
      return;
    }
    const updates = {
      ...(input.id !== undefined ? { "ui.theme": input.id } : {}),
      ...(input.mode !== undefined ? { "ui.themeMode": input.mode } : {}),
      ...Object.fromEntries(
        Object.entries(input.appearance ?? {}).map(([key, value]) => ["ui." + key, value]),
      ),
    };
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) {
        delete entries[key];
      } else {
        entries[key] = value;
      }
    }
    respond({ ...selection(), application: "saved" });
  });
  const preference = () => (entries["ui.background"] ?? null) as BackgroundPreference | null;
  const equal = (a: unknown, b: unknown): boolean => {
    if (a === b) {
      return true;
    }
    if (!a || !b || typeof a !== "object" || typeof b !== "object") {
      return false;
    }
    const left = Object.entries(a),
      right = Object.entries(b);
    return (
      left.length === right.length &&
      left.every(([key, value]) =>
        right.some(([other, next]) => key === other && equal(value, next)),
      )
    );
  };
  const snapshot = () => ({ status: "ok", asset, preference: preference() });
  gateway.setRequestHandler("users.prefs.get", ({ respond }) => respond({ status: "ok", entries }));
  gateway.setRequestHandler("users.prefs.set", ({ params, respond }) => {
    const input = params as {
      entries: Record<string, unknown>;
      expectedEntries?: Record<string, unknown>;
    };
    if (
      Object.entries(input.expectedEntries ?? {}).some(
        ([key, value]) => !equal(entries[key] ?? null, value),
      )
    ) {
      respond({ status: "conflict" });
      return;
    }
    for (const [key, value] of Object.entries(input.entries)) {
      if (value === null) {
        delete entries[key];
      } else {
        entries[key] = value;
      }
    }
    respond({ status: "ok" });
  });
  gateway.setRequestHandler("users.background.get", ({ respond }) => respond(snapshot()));
  gateway.setRequestHandler("users.background.remove", ({ params, respond }) => {
    const input = params as {
      expectedAssetId: string | null;
      expectedPreference: BackgroundPreference | null;
    };
    if (
      input.expectedAssetId !== (asset?.assetId ?? null) ||
      !equal(input.expectedPreference, preference())
    ) {
      respond({ status: "conflict" });
      return;
    }
    asset = null;
    const previous = preference();
    if (previous?.source.kind === "custom") {
      entries["ui.background"] = { ...previous, source: { kind: "none" } };
    }
    respond(snapshot());
  });
  gateway.setRequestHandler("users.background.upload", ({ params, respond }) => {
    const input = params as UsersBackgroundUploadParams;
    // Browser JPEG conversion is a fixture, not proof of server-side normalization.
    void createImageBitmap(jpeg(input.imageBase64))
      .then((bitmap) => {
        const previous = preference();
        if (
          input.expectedAssetId !== (asset?.assetId ?? null) ||
          !equal(input.expectedPreference, previous)
        ) {
          bitmap.close();
          respond({ status: "conflict" });
          return;
        }
        const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        pixels.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        image = jpeg(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]!);
        const firstUpload = asset === null;
        asset = {
          assetId: "mock-" + crypto.randomUUID(),
          width: canvas.width,
          height: canvas.height,
          byteLength: image.size,
          mime: "image/jpeg",
        };
        entries["ui.background"] = {
          ...(!firstUpload && previous
            ? previous
            : { showOnNewSession: true, showInSessions: false, visibility: 0.5 }),
          ...(previous?.presentation ? { presentation: previous.presentation } : {}),
          source: { kind: "custom", assetId: asset.assetId },
        };
        respond(snapshot());
      })
      .catch(() =>
        respond({
          __mockError: { code: "INVALID_REQUEST", message: "Could not decode this fixture image." },
        }),
      );
  });
  const fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin === location.origin &&
      url.pathname.startsWith("/__openclaw__/users/background/")
    ) {
      const found = asset && url.pathname === "/__openclaw__/users/background/" + asset.assetId;
      return Promise.resolve(
        new Response(found ? image : null, {
          status: found ? 200 : 404,
          headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" },
        }),
      );
    }
    return fetch(request);
  };
}

export function backgroundMockInitScript(): string {
  return `(() => { const __name = (target) => target; (${installBackgroundMock.toString()})(${JSON.stringify(BUILTIN_THEMES)}); })();`;
}
