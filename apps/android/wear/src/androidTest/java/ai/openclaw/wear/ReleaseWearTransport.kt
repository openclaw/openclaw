package ai.openclaw.wear

import ai.openclaw.releasevalidation.LocalWearTransport

internal fun attachReleaseWearTransport(app: WearApplication): LocalWearTransport {
  val clientField = WearApplication::class.java.getDeclaredField("proxyClient\$delegate").apply { isAccessible = true }
  val repositoryField = WearApplication::class.java.getDeclaredField("gatewayRepository\$delegate").apply { isAccessible = true }
  val previousClient = clientField.get(app)
  val previousRepository = repositoryField.get(app)
  lateinit var transport: LocalWearTransport
  val client =
    WearProxyClient(
      nodeResolver = WearNodeResolver { transport.reachablePeerNodeId() },
      transport = WearMessageTransport { target, path, bytes -> transport.send(target, path, bytes) },
    )
  transport =
    LocalWearTransport(
      role = "wear",
      nodeId = "release-wear",
      peerNodeId = "release-phone",
      socketName = "openclaw-release-wear",
      receive = { source, path, bytes -> client.handleMessage(source, path, bytes) },
      restore = {
        clientField.set(app, previousClient)
        repositoryField.set(app, previousRepository)
      },
    )
  clientField.set(app, lazyOf(client))
  repositoryField.set(app, lazyOf(WearGatewayRepository(client)))
  return transport.start()
}
