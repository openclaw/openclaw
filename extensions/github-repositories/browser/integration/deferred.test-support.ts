export function createDeferred<T = void>() {
  return Promise.withResolvers<T>();
}
