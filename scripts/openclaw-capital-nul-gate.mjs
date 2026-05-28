// 自動停用: 無效來源路徑 (CJK/.bat/nul)
export async function runDisabledGate() {
  return {
    report: { schema: "openclaw.capital.disabled-gate.v1", status: "skipped", blockers: [] },
  };
}
