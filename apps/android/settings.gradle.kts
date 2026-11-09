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
    exclusiveContent {
      forRepository {
        ivy {
          name = "libsodiumNativeArchive"
          url = uri("https://api.nuget.org/v3-flatcontainer")
          patternLayout { artifact("[module]/[revision]/[module].[revision].[ext]") }
          metadataSources { artifact() }
        }
      }
      filter { includeModule("nuget", "libsodium") }
    }
  }
}

rootProject.name = "OpenClawNodeAndroid"
include(":app")
include(":benchmark")
include(":wear")
include(":wear-shared")
