import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, isGatewayUnavailableError } from "@/lib/errors";

const NODE_ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/;

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const nodeId = searchParams.get("nodeId");

    if (nodeId !== null) {
      if (!NODE_ID_PATTERN.test(nodeId)) {
        return NextResponse.json(
          { error: "Invalid nodeId. Must be alphanumeric/hyphens, max 100 chars." },
          { status: 400 }
        );
      }
    }

    const client = getOpenClawClient();
    await client.connect();

    const data = nodeId
      ? await client.describeNode(nodeId)
      : await client.listNodes();

    return NextResponse.json(data);
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      return NextResponse.json({
        nodes: [],
        degraded: true,
        warning: "Gateway unavailable. Node information will resume after reconnection.",
      });
    }
    return handleApiError(error, "Failed to fetch node information");
  }
}, ApiGuardPresets.read);
