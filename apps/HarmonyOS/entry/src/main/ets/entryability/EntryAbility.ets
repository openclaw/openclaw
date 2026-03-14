import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { securePrefs } from '../common/SecurePrefs';
import { mainViewModel } from '../viewmodel/MainViewModel';

const DOMAIN = 0x0001;
const TAG = 'EntryAbility';

/**
 * Main Entry Ability for OpenClaw HarmonyOS
 */
export default class EntryAbility extends UIAbility {
  private windowStage: window.WindowStage | null = null;

  /**
   * Called when the ability is created
   */
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'onCreate');

    // Make UIAbilityContext available globally for resource lookups in non-UI classes
    AppStorage.setOrCreate<Context>('abilityContext', this.context);
    AppStorage.setOrCreate<number>('localeVersion', 0);

    // Initialize secure preferences
    securePrefs.init(this.context)
      .then(() => {
        hilog.info(DOMAIN, TAG, 'SecurePrefs initialized');
      })
      .catch((error: Error) => {
        hilog.error(DOMAIN, TAG, 'Failed to initialize SecurePrefs: %{public}s', error.message);
      });
  }

  /**
   * Called when the ability is destroyed
   */
  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onDestroy');
    this.windowStage = null;
  }

  /**
   * Called when the ability window is created
   */
  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageCreate');

    this.windowStage = windowStage;

    // Load the main page
    windowStage.loadContent('pages/Index', (err) => {
      if (err) {
        hilog.error(DOMAIN, TAG, 'Failed to load content: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'Content loaded successfully');
    });

    // Set window properties
    windowStage.getMainWindow().then((win: window.Window) => {
      win.setWindowBackgroundColor('#FFFFFF');
    }).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'Failed to get main window: %{public}s', err.message);
    });
  }

  /**
   * Called when the ability window is destroyed
   */
  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageDestroy');
  }

  /**
   * Called when the ability moves to foreground
   */
  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'onForeground');
    this.bumpLocaleVersion();
    mainViewModel.refreshLocalizedUiState();
  }

  /**
   * Called when the ability moves to background
   */
  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'onBackground');
  }

  private bumpLocaleVersion(): void {
    const current = AppStorage.get<number>('localeVersion') ?? 0;
    AppStorage.setOrCreate<number>('localeVersion', current + 1);
  }
}
