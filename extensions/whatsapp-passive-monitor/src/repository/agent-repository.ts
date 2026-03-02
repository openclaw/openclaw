export type AgentResult = { success: boolean; error?: string };

export type AgentRepository = {
  /** Send a message to the main agent */
  send: (message: string) => Promise<AgentResult>;
};

export class AgentRepositoryImpl implements AgentRepository {
  constructor(
    private readonly exec: (options: {
      argv: string[];
      timeoutMs: number;
    }) => Promise<{ code: number; stdout: string; stderr: string }>,
    private readonly timeoutMs: number = 120_000,
  ) {}

  async send(message: string): Promise<AgentResult> {
    try {
      const result = await this.exec({
        argv: ["openclaw", "agent", "--agent", "main", "--message", message, "--deliver"],
        timeoutMs: this.timeoutMs,
      });

      if (result.code !== 0) {
        return { success: false, error: result.stderr };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) };
    }
  }
}
