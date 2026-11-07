-dontwarn org.bouncycastle.**
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn com.sun.jna.**
-dontwarn java.awt.*
# JNA resolves interface methods and native dispatch symbols by their original names.
-keep class com.sun.jna.* { *; }
-keep class * extends com.sun.jna.* { *; }
-keepclassmembers class * extends com.sun.jna.* { public *; }
-keep interface ai.openclaw.app.gateway.CloudflareSodiumLibrary { *; }
# JNI resolves this class/method by name; UniFFI/JNA reflect over generated callbacks
# and structure fields. Preserve the generated binding package, not app adapters.
-keep class ai.openclaw.iroh.** { *; }
-keep interface ai.openclaw.iroh.** { *; }
-dontwarn javax.naming.**
-dontwarn lombok.Generated
-dontwarn org.slf4j.impl.StaticLoggerBinder
-dontwarn sun.net.spi.nameservice.NameServiceDescriptor
