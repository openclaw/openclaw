export class AuthStoragePersistenceError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AuthStoragePersistenceError";
  }
}
