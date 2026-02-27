import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DashboardConfig } from "../src/config.js";
import type { SupabaseClient } from "../src/supabase.js";
import type { Task } from "../src/types.js";

vi.mock("../src/supabase.js", () => ({
  createSupabaseClient: vi.fn(),
  supabaseFetchActiveTasksForHeartbeat: vi.fn(),
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import * as fsModule from "node:fs";
import { generateHeartbeat } from "../src/heartbeat.js";
import * as sbModule from "../src/supabase.js";

const config: DashboardConfig = {
  supabaseUrl: "https://test.supabase.co",
  supabaseServiceKey: "key",
  dashboardApiKey: "api_key",
  webhookSecret: "secret",
  heartbeatOutputFile: "memory/HEARTBEAT.md",
};

const mockClient = {} as SupabaseClient;

const sampleTask: Task = {
  id: "00000000-0000-0000-0000-000000000001",
  titulo: "Enviar proposta",
  descricao: "Detalhe aqui",
  status: "pendente",
  categoria: "follow_up",
  prioridade: 1,
  pessoa: "Emival",
  origem: "iris",
  vencimento_em: "2026-03-01T15:00:00Z",
  concluido_em: null,
  concluido_por: null,
  metadata: {},
  criado_em: "2026-02-27T00:00:00Z",
  atualizado_em: "2026-02-27T00:00:00Z",
  deleted_at: null,
};

describe("generateHeartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes HEARTBEAT.md with active tasks", async () => {
    vi.mocked(sbModule.supabaseFetchActiveTasksForHeartbeat).mockResolvedValueOnce([sampleTask]);
    await generateHeartbeat(mockClient, config, "/workspace");

    expect(fsModule.writeFileSync).toHaveBeenCalledOnce();
    const [path, content] = vi.mocked(fsModule.writeFileSync).mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(path).toContain("HEARTBEAT.md");
    expect(content).toContain("Enviar proposta");
    expect(content).toContain("Emival");
    expect(content).toContain("CRÍTICA");
  });

  it("writes empty heartbeat when no tasks", async () => {
    vi.mocked(sbModule.supabaseFetchActiveTasksForHeartbeat).mockResolvedValueOnce([]);
    await generateHeartbeat(mockClient, config, "/workspace");

    expect(fsModule.writeFileSync).toHaveBeenCalledOnce();
    const [, content] = vi.mocked(fsModule.writeFileSync).mock.calls[0] as [string, string, string];
    expect(content).toContain("Nenhuma tarefa pendente");
  });

  it("handles supabase error gracefully (no throw)", async () => {
    vi.mocked(sbModule.supabaseFetchActiveTasksForHeartbeat).mockRejectedValueOnce(
      new Error("Network error"),
    );
    await expect(generateHeartbeat(mockClient, config)).resolves.toBeUndefined();
    expect(fsModule.writeFileSync).not.toHaveBeenCalled();
  });
});
