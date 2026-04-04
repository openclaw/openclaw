export interface SessionResetter {
  resetSession(phoneNumber: string): Promise<boolean>;
}
