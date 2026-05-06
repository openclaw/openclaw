import { MainViewModel, mainViewModel } from '../viewmodel/MainViewModel';
import { OnboardingPage } from './OnboardingPage';
import { PostOnboardingTabs } from './PostOnboardingTabs';

/**
 * Index Page - Main entry point
 * Routes to onboarding or main tabs based on onboarding state.
 */
@Entry
@Component
struct Index {
  @State viewModel: MainViewModel = mainViewModel;
  @StorageProp('localeVersion') localeVersion: number = 0;
  @State showOnboarding: boolean = true;
  @State ready: boolean = false;

  aboutToAppear() {
    this.syncRoutingState();
  }

  private async syncRoutingState(): Promise<void> {
    await MainViewModel.waitUntilReadyTask(this.viewModel);
    this.showOnboarding = !this.viewModel.onboardingCompleted;
    this.ready = true;
  }

  build() {
    Column() {
      if (!this.ready) {
        Column({ space: 12 }) {
          Text('OpenClaw')
            .fontSize(28)
            .fontWeight(FontWeight.Bold)
            .fontColor('#17181C');

          Text(this.localizedText('index_loading_state', 'Loading device state…'))
            .fontSize(14)
            .fontColor('#4D5563');
        }
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .width('100%')
        .height('100%');
      } else if (this.showOnboarding) {
        OnboardingPage({
          viewModel: this.viewModel,
          onComplete: () => {
            this.showOnboarding = false;
          }
        });
      } else {
        PostOnboardingTabs({ viewModel: this.viewModel });
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF');
  }

  private localizedText(name: string, fallback: string): string {
    try {
      void this.localeVersion;
      return getContext(this).resourceManager.getStringByNameSync(name);
    } catch (error) {
      console.warn('Index: localizedText failed for key: ' + name);
      return fallback;
    }
  }
}
