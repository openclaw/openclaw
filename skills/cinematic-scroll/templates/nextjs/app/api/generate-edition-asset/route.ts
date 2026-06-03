import { NextRequest, NextResponse } from 'next/server';
import { generateEditionImage, submitEditionImage } from '@/lib/fal-generate';
import { resolveModelId, type FalImageModelId } from '@/lib/fal-models';
import type { EditionAssetPrompt } from '@/lib/prompt-contract';
import { rateLimit, requireBearer } from '@/lib/api-guard';

export const runtime = 'nodejs';
// fal-ai/flux-2-pro typically completes in 3-8s. Allow 60s headroom.
export const maxDuration = 60;

type RequestBody = EditionAssetPrompt & {
  /** "sync" (default, blocking) or "queue" (returns request_id, posts result to webhook). */
  mode?: 'sync' | 'queue';
  /** Override default FAL_IMAGE_MODEL per-request. */
  modelId?: FalImageModelId;
};

export async function POST(req: NextRequest) {
  // Guard the FAL_KEY: throttle every caller, and (if GENERATE_API_SECRET is set)
  // require a bearer token. Without this, a deployed URL is an anonymous billing drain.
  const limited = rateLimit(req);
  if (limited) return limited;

  const unauthorized = requireBearer(req);
  if (unauthorized) return unauthorized;

  if (!process.env.FAL_KEY) {
    return NextResponse.json(
      { error: 'FAL_KEY missing. Add it to .env.local (see .env.example).' },
      { status: 500 },
    );
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.chapterId || !body.subject || !body.productTruth) {
    return NextResponse.json(
      { error: 'Missing required fields: chapterId, subject, productTruth' },
      { status: 400 },
    );
  }

  const modelId = body.modelId ?? resolveModelId(process.env.FAL_IMAGE_MODEL);
  const mode = body.mode ?? 'sync';

  try {
    if (mode === 'queue') {
      const origin = req.nextUrl.origin;
      const webhookUrl = `${origin}/api/fal/webhook?chapter=${encodeURIComponent(body.chapterId)}`;
      const submission = await submitEditionImage(body, webhookUrl, modelId);
      return NextResponse.json({ status: 'queued', ...submission });
    }

    const asset = await generateEditionImage(body, modelId);
    return NextResponse.json({ status: 'ok', ...asset });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown fal.ai error';
    console.error('[generate-edition-asset]', message, error);
    return NextResponse.json({ error: message, modelId }, { status: 500 });
  }
}
