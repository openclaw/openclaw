import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import {
    RISK_LEVELS,
    isValidRiskLevel,
    getRiskConfig,
    type RiskLevel,
} from "@/lib/risk-level";

// GET /api/settings/risk-level — returns current risk level and its config
export const GET = withApiGuard(async () => {
    try {
        const current = (getSetting("risk_level") ?? "medium") as RiskLevel;
        return NextResponse.json({
            level: current,
            config: getRiskConfig(isValidRiskLevel(current) ? current : "medium"),
            availableLevels: RISK_LEVELS,
        });
    } catch (error) {
        return handleApiError(error, "Failed to get risk level");
    }
}, ApiGuardPresets.read);

// PATCH /api/settings/risk-level — change the operational posture
export const PATCH = withApiGuard(async (request: NextRequest) => {
    try {
        const body = await request.json();
        const level = body?.level;

        if (!isValidRiskLevel(level)) {
            throw new UserError(
                `Invalid risk level "${level}". Valid levels: ${RISK_LEVELS.join(", ")}`,
                400
            );
        }

        setSetting("risk_level", level);

        return NextResponse.json({
            ok: true,
            level,
            config: getRiskConfig(level),
        });
    } catch (error) {
        return handleApiError(error, "Failed to set risk level");
    }
}, ApiGuardPresets.write);
