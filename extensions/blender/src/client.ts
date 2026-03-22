/**
 * HTTP client for communicating with the OpenClaw Blender bridge addon.
 * The addon runs an HTTP server inside Blender on a configurable port.
 */

export type BlenderClientConfig = {
  host: string;
  port: number;
  timeoutMs?: number;
};

export type BlenderExecuteResult = {
  ok: boolean;
  output?: string;
  error?: string;
  result?: unknown;
};

export type BlenderSceneInfo = {
  name: string;
  objects: BlenderObjectInfo[];
  collections: string[];
  activeCamera?: string;
  renderEngine: string;
  frameStart: number;
  frameEnd: number;
  fps: number;
};

export type BlenderObjectInfo = {
  name: string;
  type: string;
  collection: string;
  location: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  visible: boolean;
  materials: string[];
  vertexCount?: number;
  faceCount?: number;
};

export type BlenderRenderResult = {
  ok: boolean;
  outputPath?: string;
  framesRendered?: number;
  error?: string;
};

export type BlenderAddonStatus = {
  running: boolean;
  blenderVersion?: string;
  addonVersion?: string;
  activeFile?: string;
};

export function createBlenderClient(config: BlenderClientConfig) {
  const baseUrl = `http://${config.host}:${config.port}`;
  const timeoutMs = config.timeoutMs ?? 60_000;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Blender bridge HTTP ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  async function get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Blender bridge HTTP ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** Check if the Blender bridge addon is running. */
    async status(): Promise<BlenderAddonStatus> {
      try {
        return await get<BlenderAddonStatus>("/status");
      } catch {
        return { running: false };
      }
    },

    /** Execute arbitrary Python code inside Blender. */
    async execute(code: string): Promise<BlenderExecuteResult> {
      return post<BlenderExecuteResult>("/execute", { code });
    },

    /** Get scene info including all objects, collections, and render settings. */
    async sceneInfo(): Promise<BlenderSceneInfo> {
      return get<BlenderSceneInfo>("/scene");
    },

    /** Trigger a render with optional overrides. */
    async render(params: {
      outputPath?: string;
      frameStart?: number;
      frameEnd?: number;
      engine?: string;
      resolutionX?: number;
      resolutionY?: number;
      samples?: number;
      camera?: string;
    }): Promise<BlenderRenderResult> {
      return post<BlenderRenderResult>("/render", params);
    },

    /** Import an asset file into the current scene. */
    async importAsset(params: {
      filePath: string;
      format: string;
      collection?: string;
    }): Promise<BlenderExecuteResult> {
      return post<BlenderExecuteResult>("/import", params);
    },

    /** Export the scene or selection to a file. */
    async exportAsset(params: {
      filePath: string;
      format: string;
      selectionOnly?: boolean;
      applyModifiers?: boolean;
      exportAnimations?: boolean;
    }): Promise<BlenderExecuteResult> {
      return post<BlenderExecuteResult>("/export", params);
    },

    /** Capture a viewport screenshot. */
    async screenshot(params: {
      outputPath: string;
      width?: number;
      height?: number;
    }): Promise<BlenderExecuteResult> {
      return post<BlenderExecuteResult>("/screenshot", params);
    },
  };
}

export type BlenderClient = ReturnType<typeof createBlenderClient>;

/** Resolve config values with sensible defaults. */
export function resolveBlenderConfig(pluginConfig: Record<string, unknown> | undefined) {
  const cfg = (pluginConfig?.["blender"] ?? {}) as Record<string, unknown>;
  return {
    executablePath: (cfg["executablePath"] as string | undefined) ?? findDefaultBlenderPath(),
    host: (cfg["bridgeHost"] as string | undefined) ?? "127.0.0.1",
    port: (cfg["bridgePort"] as number | undefined) ?? 7428,
  };
}

function findDefaultBlenderPath(): string {
  const platform = process.platform;
  if (platform === "darwin") return "/Applications/Blender.app/Contents/MacOS/Blender";
  if (platform === "win32") return "C:\\Program Files\\Blender Foundation\\Blender\\blender.exe";
  return "blender"; // expect on PATH for Linux
}
