import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

// Initialize the Hono app
const app = new Hono();

// Middleware
app.use('*', logger());
app.use('/api/*', cors({
  origin: ['https://genpark.ai', 'http://localhost:3000'], // Allow production frontend and local dev
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['POST', 'GET', 'OPTIONS'],
}));

// Basic Authentication Middleware (Mock for MVP)
app.use('/api/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer genpark-secret-token')) {
    return c.json({ error: 'Unauthorized. Invalid API Key.' }, 401);
  }
  await next();
});

// Mock Skill Registry (Simulating the loaded OpenClaw skills)
const registeredSkills = [
  'genpark-visual-search',
  'genpark-ar-tryon',
  'genpark-voice-shop',
  'genpark-sustainability-scorer',
  'genpark-community-ambassador',
  'review-summarizer'
];

/**
 * POST /api/v1/skills/invoke
 * Endpoint for the genpark.ai frontend to trigger an OpenClaw skill agent.
 */
app.post('/api/v1/skills/invoke', async (c) => {
  try {
    const body = await c.req.json();
    const { skillName, userId, context, prompt } = body;

    // Validate Input
    if (!skillName || !registeredSkills.includes(skillName)) {
      return c.json({ error: `Skill '${skillName}' is not registered or unsupported.` }, 400);
    }
    if (!userId) {
      return c.json({ error: 'Missing userId in payload.' }, 400);
    }

    console.log(`[OpenClaw Agent] Invoking skill '${skillName}' for user '${userId}'...`);
    console.log(`[Context]:`, JSON.stringify(context));
    
    // ==========================================
    // TODO: Integrate actual OpenClaw Plugin SDK here.
    // Example: await openclaw.invoke(skillName, { context, prompt });
    // ==========================================

    // Mocking the Agent Processing Delay
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Dynamic mock responses based on the skill invoked
    let outputPayload = {};

    switch (skillName) {
      case 'genpark-visual-search':
        outputPayload = {
          type: 'product_grid',
          intent: 'find_similar_items',
          items: [
            { id: '101', name: 'Vintage Leather Jacket', price: 129.99, match_score: 98, img_url: 'https://cdn.genpark.ai/item101.jpg' },
            { id: '102', name: 'Retro Denim Comfort', price: 89.99, match_score: 85, img_url: 'https://cdn.genpark.ai/item102.jpg' }
          ]
        };
        break;

      case 'genpark-community-ambassador':
        outputPayload = {
          type: 'ambassador_match',
          action: 'notify_user',
          message: 'Found 3 users discussing similar streetwear trends!',
          recommended_users: [
            { username: '@Alex_Analyst', mutual_interests: ['Vintage', 'Streetwear'] },
            { username: '@Mia_Photographer', mutual_interests: ['Photography', 'Vintage'] }
          ]
        };
        break;

      case 'genpark-sustainability-scorer':
        outputPayload = {
          type: 'sustainability_badge',
          brand: context?.brandName || 'Unknown Brand',
          score: 92,
          eco_tags: ['100% Cotton', 'Fair Trade', 'Low Carbon Footprint'],
          summary: 'This brand aligns perfectly with your conscious shopping preferences.'
        };
        break;

      default:
        outputPayload = {
          type: 'text_response',
          message: `Successfully executed ${skillName} with prompt: "${prompt}"`
        };
    }

    // Return the Generative UI JSON Schema to the frontend
    return c.json({
      status: 'success',
      agent_latency_ms: 1512,
      data: outputPayload
    });

  } catch (err: any) {
    console.error('Error invoking skill:', err);
    return c.json({ error: 'Internal Server Error processing the skill.' }, 500);
  }
});

// Health check endpoint
app.get('/health', (c) => c.json({ status: 'ok', service: 'genpark-openclaw-gateway' }));

// Start the server
const port = parseInt(process.env.PORT || '3000', 10);
console.log(`🚀 GenPark OpenClaw API Gateway is running on http://localhost:${port}`);
console.log(`Test Health: curl http://localhost:${port}/health`);

serve({
  fetch: app.fetch,
  port
});
