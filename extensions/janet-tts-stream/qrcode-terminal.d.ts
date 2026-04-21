declare module "qrcode-terminal" {
  const qrcodeTerminal: {
    generate(
      text: string,
      options?: { small?: boolean },
      callback?: (qrcode: string) => void,
    ): void;
  };

  export default qrcodeTerminal;
}
