/**
 * Message processing pipeline engine.
 *
 * Onion-model middleware engine with conditional guards (when) and named insert/remove support.
 */

import type { PipelineContext, MiddlewareDescriptor } from "./types.js";

export class MessagePipeline {
  private readonly middlewares: MiddlewareDescriptor[] = [];

  /** Register middleware at the end of the pipeline */
  use(descriptor: MiddlewareDescriptor): this {
    this.middlewares.push(descriptor);
    return this;
  }

  /** Insert before a named middleware */
  useBefore(targetName: string, descriptor: MiddlewareDescriptor): this {
    const idx = this.middlewares.findIndex((m) => m.name === targetName);
    if (idx === -1) {
      this.middlewares.push(descriptor);
    } else {
      this.middlewares.splice(idx, 0, descriptor);
    }
    return this;
  }

  /** Insert after a named middleware */
  useAfter(targetName: string, descriptor: MiddlewareDescriptor): this {
    const idx = this.middlewares.findIndex((m) => m.name === targetName);
    if (idx === -1) {
      this.middlewares.push(descriptor);
    } else {
      this.middlewares.splice(idx + 1, 0, descriptor);
    }
    return this;
  }

  /** Remove middleware by name */
  remove(name: string): this {
    const idx = this.middlewares.findIndex((m) => m.name === name);
    if (idx !== -1) {
      this.middlewares.splice(idx, 1);
    }
    return this;
  }

  /** Execute the pipeline */
  async execute(ctx: PipelineContext): Promise<void> {
    const chain = this.middlewares;
    let index = 0;

    const next = async (): Promise<void> => {
      while (index < chain.length) {
        const mw = chain[index++];

        // Conditional guard: skip middleware when `when` returns false
        if (mw.when && !mw.when(ctx)) {
          continue;
        }

        try {
          await mw.handler(ctx, next);
        } catch (err) {
          ctx.log.error(`middleware [${mw.name}] execution error`, { error: String(err) });
          throw err;
        }
        return;
      }
    };

    await next();
  }
}
