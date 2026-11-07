// Static scanner fixtures; never executed.
type Handler = (
  req: unknown,
  res: { send(body: string): void; sendStatus(code: number): void },
) => void;
type Express = Record<
  "get" | "post" | "put" | "patch" | "delete" | "options" | "head" | "all",
  (route: string, handler: Handler) => void
>;

declare function hasVerifiedBrowserAuth(req: unknown): boolean;
declare function installBrowserAuthMiddleware(app: Express, ...args: unknown[]): void;

export async function preAuthGet(app: Express) {
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.get("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
}

export async function preAuthPost(app: Express) {
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.post("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
}

export async function preAuthAll(app: Express) {
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.all("/sandbox/novnc", (req, res) => {
    res.sendStatus(405);
  });
}

export async function preAuthOtherVerbs(app: Express) {
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.put("/sandbox/novnc", (req, res) => {
    res.sendStatus(405);
  });
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.patch("/sandbox/novnc", (req, res) => {
    res.sendStatus(405);
  });
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.delete("/sandbox/novnc", (req, res) => {
    res.sendStatus(405);
  });
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.options("/sandbox/novnc", (req, res) => {
    res.sendStatus(204);
  });
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.head("/sandbox/novnc", (req, res) => {
    res.sendStatus(200);
  });
}

export async function preAuthHelperPathPost(app: Express) {
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.post("/observer/token", (req, res) => {
    res.send("ok");
  });
}

export async function preAuthRouterPost(router: Express) {
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  router.post("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
}

export async function preAuthServerGet(server: Express) {
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  server.get("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
}

export async function postAuth(app: Express, token: string) {
  installBrowserAuthMiddleware(app, { token });
  // ok: openclaw-browser-bridge-preauth-helper-route
  app.get("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
  // ok: openclaw-browser-bridge-preauth-helper-route
  app.post("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
  // ok: openclaw-browser-bridge-preauth-helper-route
  app.all("/sandbox/novnc", (req, res) => {
    res.sendStatus(405);
  });
}

export async function postAuthRouter(router: Express, token: string) {
  installBrowserAuthMiddleware(router, { token });
  // ok: openclaw-browser-bridge-preauth-helper-route
  router.post("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
}

export async function guardedHandlers(app: Express) {
  // ok: openclaw-browser-bridge-preauth-helper-route
  app.get("/sandbox/novnc", (req, res) => {
    if (!hasVerifiedBrowserAuth(req)) {
      res.sendStatus(401);
      return;
    }
    res.send("ok");
  });
  // ok: openclaw-browser-bridge-preauth-helper-route
  app.post("/sandbox/novnc", (req, res) => {
    if (!hasVerifiedBrowserAuth(req)) {
      res.sendStatus(401);
      return;
    }
    res.send("ok");
  });
}

// A route registered after the middleware must not hide an earlier
// registration of the same path under another verb.
export async function preAuthPostBeforeMiddleware(app: Express, token: string) {
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.post("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
  installBrowserAuthMiddleware(app, { token });
  // ok: openclaw-browser-bridge-preauth-helper-route
  app.get("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
}

export async function preAuthGetBeforeMiddleware(app: Express, token: string) {
  // ruleid: openclaw-browser-bridge-preauth-helper-route
  app.get("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
  installBrowserAuthMiddleware(app, { token });
  // ok: openclaw-browser-bridge-preauth-helper-route
  app.post("/sandbox/novnc", (req, res) => {
    res.send("ok");
  });
}
