//! The only process-wide Android context owner for this native library.
use jni::{
    EnvUnowned,
    errors::{Error, ThrowRuntimeExAndDefault},
    objects::{JClass, JObject},
};
use std::sync::Mutex;

static INSTALLED: Mutex<bool> = Mutex::new(false);

#[unsafe(no_mangle)]
pub extern "system" fn Java_ai_openclaw_iroh_OpenClawIrohAndroid_installNative<'local>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    context: JObject<'local>,
) {
    // with_env catches Rust unwinds before returning through JNI. Failed initialization
    // leaves INSTALLED false, permitting retry. No Activity may be retained here.
    env.with_env(|env| -> Result<(), Error> {
        let mut installed = INSTALLED.lock().map_err(|_| Error::TryLock)?;
        if *installed {
            return Ok(());
        }
        if context.is_null()
            || !env.is_instance_of(&context, jni::jni_str!("android/app/Application"))?
        {
            return Err(Error::WrongObjectType);
        }
        let vm = env.get_java_vm()?;
        let context = env.new_global_ref(&context)?;
        // SAFETY: the VM and leaked global Application reference live until process exit.
        // This is the app's sole ndk-context initializer; Kotlin calls it before bind.
        unsafe {
            iroh::dns::install_android_jni_context(vm.get_raw().cast(), context.into_raw().cast());
        }
        *installed = true;
        Ok(())
    })
    .resolve::<ThrowRuntimeExAndDefault>();
}

pub(crate) fn require_context() -> Result<(), crate::IrohError> {
    match INSTALLED.lock() {
        Ok(installed) if *installed => Ok(()),
        _ => Err(crate::invalid(
            "call OpenClawIrohAndroid.install before bind",
        )),
    }
}
