import { NextResponse } from "next/server";
import {
  createGenerationTask,
  type GenerationInput,
  type GenerationType,
} from "../../../lib/codegen-service";

const VALID_TYPES: GenerationType[] = ["web", "api", "mobile", "desktop", "cli"];

function isValidType(value: unknown): value is GenerationType {
  return typeof value === "string" && VALID_TYPES.includes(value as GenerationType);
}

function parseBody(payload: unknown): GenerationInput | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const body = payload as {
    description?: unknown;
    type?: unknown;
    tech_stack?: unknown;
  };

  if (typeof body.description !== "string" || !body.description.trim()) {
    return null;
  }
  if (!isValidType(body.type)) {
    return null;
  }

  const techStack =
    Array.isArray(body.tech_stack) && body.tech_stack.every((item) => typeof item === "string")
      ? body.tech_stack
      : undefined;

  return {
    description: body.description,
    type: body.type,
    tech_stack: techStack,
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const payload = await req.json();
    const parsed = parseBody(payload);

    if (!parsed) {
      return NextResponse.json(
        { error: "Missing or invalid required fields: description, type" },
        { status: 400 },
      );
    }

    const result = await createGenerationTask(parsed);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
