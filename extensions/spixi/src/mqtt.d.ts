declare module "mqtt" {
  interface MqttClient {
    on(event: "connect", handler: () => void): void;
    on(event: "message", handler: (topic: string, message: Buffer) => void | Promise<void>): void;
    subscribe(topic: string): void;
    end(): void;
  }

  function connect(url: string): MqttClient;

  const mqtt: {
    connect: typeof connect;
  };

  export { connect };
  export default mqtt;
}
