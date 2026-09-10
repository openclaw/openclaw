pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "OpenClawNodeAndroid"
include(":app")
include(":gateway-client")
include(":benchmark")
include(":wear")
include(":wear-shared")
