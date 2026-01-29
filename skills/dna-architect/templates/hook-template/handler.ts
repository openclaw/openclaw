/**
 * {{HOOK_NAME}} Hook Handler
 *
 * {{DESCRIPTION}}
 *
 * Events: {{EVENTS}}
 */

// Type definitions
interface HookEvent {
  type: string;
  action: string;
  sessionKey: string;
  timestamp: Date;
  messages: string[];
  context: {
    sessionEntry?: {
      sessionId?: string;
      sessionFile?: string;
      model?: string;
    };
    cfg?: any;
    bootstrapFiles?: Array<{
      path?: string;
      content: string;
      label?: string;
    }>;
    previousSessionEntry?: any;
  };
}

type HookHandler = (event: HookEvent) => Promise<void>;

/**
 * Main hook handler
 */
const handler: HookHandler = async (event) => {
  // Filter to specific event type and action
  if (event.type !== '{{EVENT_TYPE}}' || event.action !== '{{EVENT_ACTION}}') {
    return;
  }

  try {
    const context = event.context || {};

    // ═══════════════════════════════════════════════════════════
    // YOUR LOGIC HERE
    // ═══════════════════════════════════════════════════════════

    // Example: Inject content into agent context
    // if (context.bootstrapFiles) {
    //   context.bootstrapFiles.push({
    //     label: '{{Label}}',
    //     content: `\n## {{Title}}\n{{Content}}\n`,
    //   });
    // }

    // Example: Access session info
    // const sessionFile = context.sessionEntry?.sessionFile;
    // const model = context.sessionEntry?.model;

    // Example: Access config
    // const cfg = context.cfg;
    // const someValue = cfg?.some?.config?.path;

    console.log('[{{HOOK_NAME}}] Hook executed successfully');

  } catch (err) {
    // Don't throw - let other handlers run
    console.error(
      '[{{HOOK_NAME}}] Error:',
      err instanceof Error ? err.message : String(err)
    );
  }
};

export default handler;
