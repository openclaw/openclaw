/** MES production dispatch — webhook or simulate per CLAWORKS_MES_* env. */
export async function mesProductionDispatch(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const webhook =
    process.env.CLAWORKS_MES_PRODUCTION_WEBHOOK_URL?.trim() ||
    process.env.CLAWORKS_MES_WEBHOOK_URL?.trim();

  const body = {
    station_id: params.station_id,
    workorder_id: params.workorder_id ?? params.work_order_id,
    priority: params.priority ?? "normal",
    notes: params.notes,
    dispatched_at: new Date().toISOString(),
  };

  if (!webhook) {
    return {
      status: "ok",
      mode: "simulate",
      ...body,
      message: "MES webhook not configured (set CLAWORKS_MES_PRODUCTION_WEBHOOK_URL)",
    };
  }

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MES dispatch failed ${res.status}: ${text}`);
  }
  let response: unknown = null;
  try {
    response = await res.json();
  } catch {
    response = { accepted: true };
  }
  return { status: "ok", mode: "webhook", ...body, response };
}
