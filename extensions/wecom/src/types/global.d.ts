declare global {
  var Buffer: unknown;
  namespace NodeJS {
    interface Timeout {}
  }
}
