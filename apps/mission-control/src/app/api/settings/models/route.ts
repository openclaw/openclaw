import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  listLocalModels,
  getLocalModel,
  createLocalModel,
  updateLocalModel,
  deleteLocalModel,
} from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";

// --- Ollama integration ---

interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

async function fetchOllamaModels(
  baseUrl: string = "http://localhost:11434"
): Promise<{ available: boolean; models: OllamaModel[] }> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return { available: false, models: [] };
    }

    const data = (await response.json()) as OllamaTagsResponse;
    return {
      available: true,
      models: data.models || [],
    };
  } catch {
    return { available: false, models: [] };
  }
}

// Provider-aware health check (Ollama uses /api/tags, LM Studio / vLLM / etc. use /v1/models)
async function checkModelHealth(
  provider: string,
  baseUrl: string
): Promise<{ available: boolean }> {
  const endpoint =
    provider === "ollama"
      ? `${baseUrl}/api/tags`
      : `${baseUrl}/v1/models`; // LM Studio, vLLM, etc.

  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(5_000),
    });
    return { available: response.ok };
  } catch {
    return { available: false };
  }
}

// GET /api/settings/models -- list registered models + Ollama discovery
export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const includeOllama = searchParams.get("ollama") !== "false";

    const registered = listLocalModels();

    let ollamaStatus: {
      available: boolean;
      models: OllamaModel[];
    } = { available: false, models: [] };

    if (includeOllama) {
      // Use the client-provided ollamaUrl, or the first registered ollama model's base_url, or default
      const clientOllamaUrl = searchParams.get("ollamaUrl");
      const ollamaEntry = registered.find(
        (m) => m.provider === "ollama"
      );
      const baseUrl =
        clientOllamaUrl || ollamaEntry?.base_url || "http://localhost:11434";
      ollamaStatus = await fetchOllamaModels(baseUrl);
    }

    return NextResponse.json({
      models: registered,
      ollamaAvailable: ollamaStatus.available,
      ollamaModels: ollamaStatus.models,
    });
  } catch (error) {
    return handleApiError(error, "Failed to list local models");
  }
}, ApiGuardPresets.read);

// POST /api/settings/models -- register a local model
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const body = await request.json();

    const name = body?.name?.trim();
    const modelId = body?.model_id?.trim();
    const provider = body?.provider?.trim() || "ollama";
    const baseUrl =
      body?.base_url?.trim() || "http://localhost:11434";
    const parameters = body?.parameters
      ? JSON.stringify(body.parameters)
      : "{}";

    if (!name) {throw new UserError("name is required", 400);}
    if (!modelId) {throw new UserError("model_id is required", 400);}

    const model = createLocalModel({
      id: uuidv4(),
      name,
      provider,
      model_id: modelId,
      base_url: baseUrl,
      parameters,
    });

    return NextResponse.json(
      { ok: true, model },
      { status: 201 }
    );
  } catch (error) {
    return handleApiError(error, "Failed to create local model");
  }
}, ApiGuardPresets.write);

// PATCH /api/settings/models -- update model config or health check
export const PATCH = withApiGuard(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const id = body?.id;
    if (!id) {throw new UserError("id is required", 400);}

    const existing = getLocalModel(id);
    if (!existing) {throw new UserError("Model not found", 404);}

    // If healthCheck=true, ping the model's provider
    if (body.healthCheck === true) {
      const result = await checkModelHealth(existing.provider || "ollama", existing.base_url);
      const now = new Date().toISOString();
      const status = result.available ? "healthy" : "unreachable";

      updateLocalModel(id, {
        last_health_at: now,
        last_health_status: status,
      });

      const updated = getLocalModel(id)!;
      return NextResponse.json({
        ok: true,
        healthResult: { available: result.available, status },
        model: updated,
      });
    }

    // Build patch from allowed fields
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {patch.name = body.name.trim();}
    if (body.model_id !== undefined)
      {patch.model_id = body.model_id.trim();}
    if (body.base_url !== undefined)
      {patch.base_url = body.base_url.trim();}
    if (body.is_active !== undefined)
      {patch.is_active = body.is_active ? 1 : 0;}
    if (body.parameters !== undefined)
      {patch.parameters = JSON.stringify(body.parameters);}

    const updated = updateLocalModel(
      id,
      patch as Parameters<typeof updateLocalModel>[1]
    );
    if (!updated) {throw new UserError("Model not found", 404);}

    return NextResponse.json({ ok: true, model: updated });
  } catch (error) {
    return handleApiError(error, "Failed to update local model");
  }
}, ApiGuardPresets.write);

// DELETE /api/settings/models -- remove a registered model
export const DELETE = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {throw new UserError("id query param is required", 400);}

    const existing = getLocalModel(id);
    if (!existing) {throw new UserError("Model not found", 404);}

    deleteLocalModel(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to delete local model");
  }
}, ApiGuardPresets.write);
