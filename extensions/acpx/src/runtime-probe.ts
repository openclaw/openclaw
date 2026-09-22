/** Serialized diagnostics and health observations for one ACPX runtime generation. */
import type { AcpxRuntime, AcpRuntimeDoctorReport } from "acpx/runtime";

type AcpxRuntimeProbeParams = {
  getAgent: () => string;
  createRuntime: (agent: string) => Pick<AcpxRuntime, "doctor" | "shutdown">;
  assertRunning: () => void;
  runWithLease: (
    agent: string,
    run: () => Promise<AcpRuntimeDoctorReport>,
  ) => Promise<AcpRuntimeDoctorReport>;
};

export class AcpxRuntimeProbe {
  private tail: Promise<unknown> = Promise.resolve();
  private health?: { agent: string; ok: boolean };

  constructor(private readonly params: AcpxRuntimeProbeParams) {}

  isHealthy(): boolean {
    return (
      this.health !== undefined && (this.health.agent !== this.params.getAgent() || this.health.ok)
    );
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    const probe = this.tail.then(async () => {
      this.params.assertRunning();
      const agent = this.params.getAgent();
      const runtime = this.params.createRuntime(agent);
      try {
        const report = await this.params.runWithLease(agent, () => runtime.doctor());
        this.params.assertRunning();
        this.health = { agent, ok: report.ok };
        return report;
      } finally {
        await runtime.shutdown();
      }
    });
    this.tail = probe.catch(() => {});
    return await probe;
  }

  async shutdown(): Promise<void> {
    this.health = undefined;
    await this.tail;
  }
}
