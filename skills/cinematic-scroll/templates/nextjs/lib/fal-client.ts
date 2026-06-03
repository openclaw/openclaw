import { fal } from '@fal-ai/client';

let configured = false;

export function configureFalClient() {
  if (configured) return fal;
  fal.config({
    proxyUrl: '/api/fal/proxy',
  });
  configured = true;
  return fal;
}
