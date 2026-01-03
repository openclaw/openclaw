package com.clawdis.android

import android.app.Application

class NodeApp : Application() {
  val runtime: NodeRuntime by lazy { NodeRuntime(this) }
}

