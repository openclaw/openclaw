/**
 * Message processing pipeline engine
 *
 * 洋葱模型中间件引擎，支持条件守卫（when）和按名称插入/移除中间件。
 */

import type { PipelineContext, MiddlewareDescriptor } from "./types.js";

export class MessagePipeline {
  private readonly middlewares: MiddlewareDescriptor[] = [];

  /** 注册中间件到管线末尾 */
  use(descriptor: MiddlewareDescriptor): this {
    this.middlewares.push(descriptor);
    return this;
  }

  /** 在指定中间件之前插入 */
  useBefore(targetName: string, descriptor: MiddlewareDescriptor): this {
    const idx = this.middlewares.findIndex((m) => m.name === targetName);
    if (idx === -1) {
      this.middlewares.push(descriptor);
    } else {
      this.middlewares.splice(idx, 0, descriptor);
    }
    return this;
  }

  /** 在指定中间件之后插入 */
  useAfter(targetName: string, descriptor: MiddlewareDescriptor): this {
    const idx = this.middlewares.findIndex((m) => m.name === targetName);
    if (idx === -1) {
      this.middlewares.push(descriptor);
    } else {
      this.middlewares.splice(idx + 1, 0, descriptor);
    }
    return this;
  }

  /** 按名称移除中间件 */
  remove(name: string): this {
    const idx = this.middlewares.findIndex((m) => m.name === name);
    if (idx !== -1) {
      this.middlewares.splice(idx, 1);
    }
    return this;
  }

  /** 执行管线 */
  async execute(ctx: PipelineContext): Promise<void> {
    const chain = this.middlewares;
    let index = 0;

    const next = async (): Promise<void> => {
      while (index < chain.length) {
        const mw = chain[index++];

        // 条件守卫：when 返回 false 时跳过该中间件
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
