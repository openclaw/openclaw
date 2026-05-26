// Minimal ambient declaration for the Bun runtime surface this proxy uses.
//
// The interactive proxy ships as a Bun-run source asset, so it cannot pull in
// `bun-types` without making Bun a build-time dependency of the node-only CI
// typecheck lane. Declaring just the `Bun.serve`/`Bun.file` surface keeps the
// shipped runtime inside `tsgo` validation (`pnpm tsgo:extensions:interactive-proxy`)
// while leaving the full Bun runtime to ship time. Everything else the proxy
// touches (`fetch`, `Request`, `Response`, `Headers`, `URL`, `TransformStream`,
// `TextDecoder`) resolves from the repo's DOM + node lib config.

interface BunServeOptions {
  port?: number;
  hostname?: string;
  idleTimeout?: number;
  tls?: {
    key: unknown;
    cert: unknown;
  };
  fetch(req: Request): Response | Promise<Response>;
}

interface BunServer {
  /** Bound listen port; populated synchronously once `serve` returns. */
  readonly port?: number;
  stop(closeActiveConnections?: boolean): void;
}

declare const Bun: {
  serve(options: BunServeOptions): BunServer;
  file(path: string): unknown;
};
