declare module "localtunnel" {
  interface Tunnel {
    url: string;
    close: () => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
  }
  interface TunnelOptions {
    port: number;
    subdomain?: string;
    host?: string;
  }
  function localtunnel(opts: TunnelOptions): Promise<Tunnel>;
  export default localtunnel;
}
