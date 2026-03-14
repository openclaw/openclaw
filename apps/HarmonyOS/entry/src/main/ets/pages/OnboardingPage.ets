import { MainViewModel } from '../viewmodel/MainViewModel';
import { LocationMode } from '../common/SecurePrefs';

const C_BG_TOP: string = '#FFFFFF';
const C_BG_MID: string = '#F7F8FA';
const C_BG_BOT: string = '#EFF1F5';
const C_SURFACE: string = '#F6F7FA';
const C_BORDER: string = '#E5E7EC';
const C_BORDER_STRONG: string = '#D6DAE2';
const C_TEXT: string = '#17181C';
const C_TEXT_SEC: string = '#4D5563';
const C_TEXT_TER: string = '#8A92A2';
const C_ACCENT: string = '#1D5DD8';
const C_ACCENT_SOFT: string = '#ECF3FF';
const C_SUCCESS: string = '#2F8C5A';
const C_WARNING: string = '#C8841A';
const C_CMD_BG: string = '#15171B';
const C_CMD_BORDER: string = '#2B2E35';
const C_CMD_ACCENT: string = '#3FC97A';
const C_CMD_TEXT: string = '#E8EAEE';

@Component
export struct OnboardingPage {
  @ObjectLink viewModel: MainViewModel;
  @StorageProp('localeVersion') localeVersion: number = 0;
  onComplete: () => void = () => {};

  @State currentStep: number = 1;
  @State setupCode: string = '';
  @State gatewayToken: string = '';
  @State gatewayPassword: string = '';
  @State inputMode: string = 'SetupCode';
  @State advancedOpen: boolean = false;
  @State manualHost: string = '10.0.2.2';
  @State manualPort: string = '18789';
  @State manualTls: boolean = false;
  @State gatewayError: string = '';
  @State attemptedConnect: boolean = false;
  @State isConnecting: boolean = false;
  @State connectedState: boolean = false;
  @State statusState: string = '';
  @State serverNameState: string = '';
  @State remoteAddressState: string = '';

  @State enableDiscovery: boolean = false;
  @State enableLocation: boolean = false;
  @State enableNotifications: boolean = false;
  @State enableMicrophone: boolean = false;
  @State enableCamera: boolean = false;
  @State enablePhotos: boolean = false;
  @State enableContacts: boolean = false;
  @State enableCalendar: boolean = false;
  @State enableMotion: boolean = false;
  @State enableSms: boolean = false;

  private readonly totalSteps: number = 4;
  private connectionStateListenerId: number = -1;

  aboutToAppear(): void {
    this.manualHost = this.viewModel.manualHost || '';
    this.manualPort = this.viewModel.manualPort > 0 ? this.viewModel.manualPort.toString() : '18789';
    this.manualTls = this.viewModel.manualTls;
    this.gatewayToken = this.viewModel.gatewayToken || '';
    this.enableCamera = this.viewModel.cameraEnabled;
    this.enableLocation = this.viewModel.locationMode !== 'off';
    this.enableMicrophone = this.viewModel.micEnabled;
    this.enableDiscovery = true;
    this.enableNotifications = true;
    this.enablePhotos = true;
    this.enableContacts = false;
    this.enableCalendar = false;
    this.enableMotion = false;
    this.enableSms = false;

    if (this.viewModel.manualEnabled || this.viewModel.manualHost.trim().length > 0 || this.viewModel.gatewayToken.trim().length > 0) {
      this.inputMode = 'Manual';
    }

    this.syncConnectionState();
    this.connectionStateListenerId = this.viewModel.addConnectionStateListener(() => {
      this.syncConnectionState();
    });
  }

  aboutToDisappear(): void {
    if (this.connectionStateListenerId >= 0) {
      this.viewModel.removeConnectionStateListener(this.connectionStateListenerId);
      this.connectionStateListenerId = -1;
    }
  }

  private enabledPermissionSummary(): string {
    const enabled: string[] = [];
    if (this.enableDiscovery) { enabled.push(this.localizedText('onboarding_perm_gateway_discovery_title', 'Gateway discovery')); }
    if (this.enableLocation) { enabled.push(this.localizedText('onboarding_perm_location_title', 'Location')); }
    if (this.enableNotifications) { enabled.push(this.localizedText('onboarding_perm_notifications_title', 'Notifications')); }
    if (this.enableMicrophone) { enabled.push(this.localizedText('onboarding_perm_microphone_title', 'Microphone')); }
    if (this.enableCamera) { enabled.push(this.localizedText('onboarding_perm_camera_title', 'Camera')); }
    if (this.enablePhotos) { enabled.push(this.localizedText('onboarding_perm_photos_title', 'Photos')); }
    if (this.enableContacts) { enabled.push(this.localizedText('onboarding_perm_contacts_title', 'Contacts')); }
    if (this.enableCalendar) { enabled.push(this.localizedText('onboarding_perm_calendar_title', 'Calendar')); }
    if (this.enableMotion) { enabled.push(this.localizedText('onboarding_perm_motion_title', 'Motion')); }
    if (this.enableSms) { enabled.push(this.localizedText('onboarding_perm_sms_title', 'SMS')); }
    return enabled.length > 0 ? enabled.join(', ') : this.localizedText('onboarding_none_selected', 'None selected');
  }

  private resolvedGatewayDisplay(): string {
    if (this.inputMode === 'SetupCode') {
      const code = this.setupCode.trim();
      if (code.length === 0) {
        return '';
      }
      if (code.startsWith('ws://') || code.startsWith('wss://') || code.startsWith('http://') || code.startsWith('https://')) {
        return code;
      }
      return `openclaw://${code}`;
    }
    const scheme = this.manualTls ? 'wss' : 'ws';
    const host = this.manualHost.trim();
    const port = this.manualPort.trim();
    return host.length > 0 && port.length > 0 ? `${scheme}://${host}:${port}` : '';
  }

  private methodLabel(): string {
    return this.inputMode === 'SetupCode'
      ? this.localizedText('onboarding_mode_setup_code', 'Setup Code')
      : this.localizedText('onboarding_mode_manual', 'Manual');
  }

  build() {
    Column() {
      Column() {
        Text(this.localizedText('onboarding_first_run', 'FIRST RUN'))
          .fontSize(12)
          .fontWeight(FontWeight.Bold)
          .fontColor(C_ACCENT)
          .letterSpacing(1.5);

        Text(this.localizedText('onboarding_title', 'OpenClaw\nMobile Setup'))
          .fontSize(34)
          .fontWeight(FontWeight.Bold)
          .fontColor(C_TEXT)
          .lineHeight(38)
          .margin({ top: 4, bottom: 4 });

        Text(this.currentStepText())
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor(C_ACCENT);
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ top: 40, bottom: 16, left: 20, right: 20 });

      this.StepRail();

      Scroll() {
        Column() {
          if (this.currentStep === 1) {
            this.WelcomeStep();
          } else if (this.currentStep === 2) {
            this.GatewayStep();
          } else if (this.currentStep === 3) {
            this.PermissionsStep();
          } else {
            this.FinalCheckStep();
          }
        }
        .width('100%')
        .padding({ left: 20, right: 20, top: 8, bottom: 8 });
      }
      .width('100%')
      .layoutWeight(1);

      this.NavigationButtons();
    }
    .width('100%')
    .height('100%')
    .linearGradient({
      angle: 180,
      colors: [[C_BG_TOP, 0.0], [C_BG_MID, 0.5], [C_BG_BOT, 1.0]]
    });
  }

  @Builder StepRail() {
    Divider().color(C_BORDER).width('100%');
    Row() {
      ForEach([1, 2, 3, 4], (step: number) => {
        Column() {
          Row()
            .width('100%')
            .height(5)
            .borderRadius(999)
            .backgroundColor(step < this.currentStep ? C_SUCCESS : (step === this.currentStep ? C_ACCENT : C_BORDER));

          Text(this.stepLabel(step))
            .fontSize(11)
            .fontWeight(step === this.currentStep ? FontWeight.Bold : FontWeight.Medium)
            .fontColor(step === this.currentStep ? C_ACCENT : C_TEXT_SEC)
            .margin({ top: 4 })
            .maxLines(1);
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Center)
        .padding({ left: 2, right: 2 });
      });
    }
    .width('100%')
    .padding({ left: 20, right: 20, top: 8, bottom: 8 });
    Divider().color(C_BORDER).width('100%');
  }

  @Builder WelcomeStep() {
    Column() {
      this.SectionHeader(this.localizedText('onboarding_welcome_header', 'What You Get'));
      Column() {
        this.Bullet(this.localizedText('onboarding_welcome_bullet_1', 'Control the gateway and operator chat from one mobile surface.'));
        this.Bullet(this.localizedText('onboarding_welcome_bullet_2', 'Connect with setup code or manual endpoint details.'));
        this.Bullet(this.localizedText('onboarding_welcome_bullet_3', 'Enable only the capabilities you want available later.'));
        this.Bullet(this.localizedText('onboarding_welcome_bullet_4', 'Finish with a live connection check before entering the app.'));
      }
      .width('100%')
      .padding({ top: 8, bottom: 8 });
    }
    .width('100%');
  }

  @Builder GatewayStep() {
    Column({ space: 12 }) {
      this.SectionHeader(this.localizedText('onboarding_gateway_header', 'Gateway Connection'));

      Row() {
        Row()
          .width(2)
          .height('100%')
          .backgroundColor('#661D5DD8');
        Column({ space: 8 }) {
          Text(this.localizedText('onboarding_setup_instructions', 'Setup instructions'))
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor(C_TEXT);
          Text(this.localizedText('onboarding_run_on_gateway_host', 'Run these on the gateway host:'))
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(C_TEXT_SEC);
          this.CommandBlock('openclaw qr --setup-code-only');
          this.CommandBlock('openclaw qr --json');
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        .padding({ left: 12 });
      }
      .width('100%')
      .alignItems(VerticalAlign.Top);

      Row() {
        this.ModeChip(this.localizedText('onboarding_mode_setup_code', 'Setup Code'), this.inputMode === 'SetupCode', () => {
          this.inputMode = 'SetupCode';
          this.gatewayError = '';
        });
        this.ModeChip(this.localizedText('onboarding_mode_manual', 'Manual'), this.inputMode === 'Manual', () => {
          this.inputMode = 'Manual';
          this.gatewayError = '';
        });
      }
      .width('100%');

      if (this.inputMode === 'SetupCode') {
        Text(this.localizedText('onboarding_setup_code_label', 'SETUP CODE'))
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor(C_TEXT_SEC)
          .letterSpacing(0.9);

        TextArea({ placeholder: this.localizedText('onboarding_setup_code_placeholder', 'Paste code from openclaw qr --setup-code-only'), text: this.setupCode })
          .width('100%')
          .height(100)
          .backgroundColor(C_SURFACE)
          .borderColor(C_BORDER)
          .borderWidth(1)
          .borderRadius(12)
          .padding({ left: 12, right: 12, top: 10, bottom: 10 })
          .fontSize(14)
          .fontColor(C_TEXT)
          .onChange((value: string) => {
            this.setupCode = value;
            this.gatewayError = '';
          });
      } else {
        Row() {
          this.QuickFillChip(this.localizedText('onboarding_quickfill_emulator', 'HarmonyOS Emulator'), () => {
            this.manualHost = '10.0.2.2';
            this.manualPort = '18789';
            this.manualTls = false;
            this.gatewayError = '';
          });
          this.QuickFillChip(this.localizedText('onboarding_quickfill_localhost', 'Localhost'), () => {
            this.manualHost = '127.0.0.1';
            this.manualPort = '18789';
            this.manualTls = false;
            this.gatewayError = '';
          });
        }

        Text(this.localizedText('onboarding_host_label', 'HOST'))
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor(C_TEXT_SEC)
          .letterSpacing(0.9);
        TextInput({ placeholder: '10.0.2.2', text: this.manualHost })
          .width('100%')
          .height(50)
          .backgroundColor(C_SURFACE)
          .borderColor(C_BORDER)
          .borderWidth(1)
          .borderRadius(12)
          .padding({ left: 12, right: 12 })
          .fontSize(14)
          .fontColor(C_TEXT)
          .onChange((value: string) => {
            this.manualHost = value;
            this.gatewayError = '';
          });

        Text(this.localizedText('onboarding_port_label', 'PORT'))
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor(C_TEXT_SEC)
          .letterSpacing(0.9);
        TextInput({ placeholder: '18789', text: this.manualPort })
          .width('100%')
          .height(50)
          .backgroundColor(C_SURFACE)
          .borderColor(C_BORDER)
          .borderWidth(1)
          .borderRadius(12)
          .padding({ left: 12, right: 12 })
          .fontSize(14)
          .fontColor(C_TEXT)
          .type(InputType.Number)
          .onChange((value: string) => {
            this.manualPort = value;
            this.gatewayError = '';
          });

        Row() {
          Column({ space: 2 }) {
            Text(this.localizedText('onboarding_use_tls', 'Use TLS')).fontSize(15).fontWeight(FontWeight.Medium).fontColor(C_TEXT);
            Text(this.localizedText('onboarding_use_tls_desc', 'Switch to secure websocket (wss).')).fontSize(13).fontWeight(FontWeight.Medium).fontColor(C_TEXT_SEC);
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1);

          Toggle({ type: ToggleType.Switch, isOn: this.manualTls })
            .selectedColor(C_ACCENT)
            .onChange((isOn: boolean) => {
              this.manualTls = isOn;
              this.gatewayError = '';
            });
        }
        .width('100%');

        Row() {
          Text(this.localizedText('onboarding_advanced_options', 'Advanced Options')).fontSize(14).fontWeight(FontWeight.Medium).fontColor(C_ACCENT);
          Blank();
          Text(this.advancedOpen ? '▼' : '▶').fontSize(12).fontColor(C_ACCENT);
        }
        .width('100%')
        .padding({ top: 8, bottom: 8 })
        .onClick(() => {
          this.advancedOpen = !this.advancedOpen;
        });

        if (this.advancedOpen) {
          Column({ space: 10 }) {
            Text(this.localizedText('onboarding_token_optional', 'TOKEN (OPTIONAL)'))
              .fontSize(11)
              .fontWeight(FontWeight.Medium)
              .fontColor(C_TEXT_SEC)
              .letterSpacing(0.9);
            TextInput({ placeholder: this.localizedText('onboarding_token_placeholder', 'token'), text: this.gatewayToken })
              .width('100%')
              .height(50)
              .backgroundColor(C_SURFACE)
              .borderColor(C_BORDER)
              .borderWidth(1)
              .borderRadius(12)
              .padding({ left: 12, right: 12 })
              .fontSize(14)
              .fontColor(C_TEXT)
              .type(InputType.Password)
              .onChange((value: string) => {
                this.gatewayToken = value;
              });

            Text(this.localizedText('onboarding_password_optional', 'PASSWORD (OPTIONAL)'))
              .fontSize(11)
              .fontWeight(FontWeight.Medium)
              .fontColor(C_TEXT_SEC)
              .letterSpacing(0.9);
            TextInput({ placeholder: this.localizedText('onboarding_password_placeholder', 'password'), text: this.gatewayPassword })
              .width('100%')
              .height(50)
              .backgroundColor(C_SURFACE)
              .borderColor(C_BORDER)
              .borderWidth(1)
              .borderRadius(12)
              .padding({ left: 12, right: 12 })
              .fontSize(14)
              .fontColor(C_TEXT)
              .type(InputType.Password)
              .onChange((value: string) => {
                this.gatewayPassword = value;
              });
          }
          .width('100%');
        }
      }

      if (this.resolvedGatewayDisplay().length > 0) {
        this.ResolvedEndpoint(this.resolvedGatewayDisplay());
      }

      if (this.gatewayError.length > 0) {
        Text(this.gatewayError)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor(C_WARNING);
      }
    }
    .width('100%');
  }

  @Builder PermissionsStep() {
    Column() {
      this.SectionHeader(this.localizedText('onboarding_permissions_header', 'Permissions'));
      Text(this.localizedText('onboarding_permissions_intro', 'Enable only what you need now. You can change everything later in Settings.'))
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(C_TEXT_SEC)
        .margin({ bottom: 16 });

      Column() {
        this.PermRow(this.localizedText('onboarding_perm_gateway_discovery_title', 'Gateway Discovery'), this.localizedText('onboarding_perm_gateway_discovery_desc', 'Find gateways on your local network'), this.enableDiscovery, (v: boolean) => { this.enableDiscovery = v; });
        Divider().color(C_BORDER);
        this.PermRow(this.localizedText('onboarding_perm_location_title', 'Location'), this.localizedText('onboarding_perm_location_desc', 'location.get while the app is open'), this.enableLocation, (v: boolean) => { this.enableLocation = v; });
        Divider().color(C_BORDER);
        this.PermRow(this.localizedText('onboarding_perm_notifications_title', 'Notifications'), this.localizedText('onboarding_perm_notifications_desc', 'system notifications and foreground alerts'), this.enableNotifications, (v: boolean) => { this.enableNotifications = v; });
        Divider().color(C_BORDER);
        this.PermRow(this.localizedText('onboarding_perm_microphone_title', 'Microphone'), this.localizedText('onboarding_perm_microphone_desc', 'Voice tab transcription'), this.enableMicrophone, (v: boolean) => { this.enableMicrophone = v; });
        Divider().color(C_BORDER);
        this.PermRow(this.localizedText('onboarding_perm_camera_title', 'Camera'), this.localizedText('onboarding_perm_camera_desc', 'camera.snap and camera.clip'), this.enableCamera, (v: boolean) => { this.enableCamera = v; });
        Divider().color(C_BORDER);
        this.PermRow(this.localizedText('onboarding_perm_photos_title', 'Photos'), this.localizedText('onboarding_perm_photos_desc', 'photos.latest'), this.enablePhotos, (v: boolean) => { this.enablePhotos = v; });
        Divider().color(C_BORDER);
        this.PermRow(this.localizedText('onboarding_perm_contacts_title', 'Contacts'), this.localizedText('onboarding_perm_contacts_desc', 'contacts.search and contacts.add'), this.enableContacts, (v: boolean) => { this.enableContacts = v; });
        Divider().color(C_BORDER);
        this.PermRow(this.localizedText('onboarding_perm_calendar_title', 'Calendar'), this.localizedText('onboarding_perm_calendar_desc', 'calendar.events and calendar.add'), this.enableCalendar, (v: boolean) => { this.enableCalendar = v; });
        Divider().color(C_BORDER);
        this.PermRow(this.localizedText('onboarding_perm_motion_title', 'Motion'), this.localizedText('onboarding_perm_motion_desc', 'motion.activity and motion.pedometer'), this.enableMotion, (v: boolean) => { this.enableMotion = v; });
        Divider().color(C_BORDER);
        this.PermRow(this.localizedText('onboarding_perm_sms_title', 'SMS'), this.localizedText('onboarding_perm_sms_desc', 'Allow gateway-triggered SMS sending'), this.enableSms, (v: boolean) => { this.enableSms = v; });
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 16, bottom: 16 })
      .backgroundColor(C_SURFACE)
      .borderRadius(12)
      .border({ width: 1, color: C_BORDER });

      Text(this.localizedText('onboarding_permissions_footer', 'All settings can be changed later in Settings.'))
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor(C_TEXT_SEC)
        .margin({ top: 12 });
    }
    .width('100%');
  }

  @Builder PermRow(title: string, subtitle: string, isOn: boolean, onChange: (v: boolean) => void) {
    Row() {
      Column() {
        Text(title).fontSize(15).fontWeight(FontWeight.Medium).fontColor(C_TEXT);
        Text(subtitle).fontSize(13).fontWeight(FontWeight.Medium).fontColor(C_TEXT_SEC);
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);

      Toggle({ type: ToggleType.Switch, isOn: isOn })
        .selectedColor(C_ACCENT)
        .onChange((v: boolean) => {
          onChange(v);
        });
    }
    .width('100%')
    .padding({ top: 12, bottom: 12 });
  }

  @Builder FinalCheckStep() {
    Column() {
      this.SectionHeader(this.localizedText('onboarding_review_header', 'Review'));
      this.SummaryField(this.localizedText('onboarding_summary_method', 'Method'), this.methodLabel());
      this.SummaryField(this.localizedText('onboarding_summary_gateway', 'Gateway'), this.resolvedGatewayDisplay().length > 0 ? this.resolvedGatewayDisplay() : this.localizedText('onboarding_not_set', '(not set)'));
      this.SummaryField(this.localizedText('onboarding_summary_permissions', 'Enabled Permissions'), this.enabledPermissionSummary());

      if (!this.attemptedConnect) {
        Text(this.localizedText('onboarding_press_connect', 'Press Connect to verify gateway reachability and auth.'))
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor(C_TEXT_SEC)
          .margin({ top: 12 });
      } else {
        Text(this.statusLineText())
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.connectedState ? C_SUCCESS : C_TEXT_SEC)
          .margin({ top: 12 });

        if (this.connectedState) {
          Text(this.connectedToText())
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(C_SUCCESS)
            .margin({ top: 4 });
        } else {
          Row() {
            Row()
              .width(2)
              .height('100%')
              .backgroundColor('#661D5DD8');
            Column() {
              Text(this.localizedText('onboarding_pairing_required', 'Pairing Required'))
                .fontSize(15)
                .fontWeight(FontWeight.Medium)
                .fontColor(C_TEXT)
                .margin({ bottom: 8 });
              Text(this.localizedText('onboarding_run_on_gateway_host', 'Run these on the gateway host:'))
                .fontSize(14)
                .fontWeight(FontWeight.Medium)
                .fontColor(C_TEXT_SEC);
              this.CommandBlock('openclaw devices list');
              this.CommandBlock('openclaw devices approve <requestId>');
              Text(this.localizedText('onboarding_tap_connect_again', 'Then tap Connect again.'))
                .fontSize(14)
                .fontWeight(FontWeight.Medium)
                .fontColor(C_TEXT_SEC);
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
            .padding({ left: 12 });
          }
          .width('100%')
          .margin({ bottom: 12 })
          .alignItems(VerticalAlign.Top);
        }
      }

      if (this.gatewayError.length > 0) {
        Text(this.gatewayError)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor(C_WARNING)
          .margin({ top: 12 });
      }
    }
    .width('100%');
  }

  @Builder NavigationButtons() {
    Divider().color(C_BORDER).width('100%');
    Row() {
      Button({ type: ButtonType.Normal }) {
        Text('‹')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.currentStep > 1 ? C_TEXT_SEC : C_TEXT_TER);
      }
      .width(52)
      .height(52)
      .borderRadius(14)
      .backgroundColor(C_SURFACE)
      .border({ width: 1, color: this.currentStep > 1 ? C_BORDER_STRONG : C_BORDER })
      .margin({ right: 10 })
      .enabled(this.currentStep > 1)
      .onClick(() => {
        if (this.currentStep > 1) {
          this.currentStep--;
        }
      });

      if (this.currentStep === 1) {
        Button({ type: ButtonType.Normal }) {
          Text(this.localizedText('onboarding_next', 'Next')).fontSize(16).fontWeight(FontWeight.Bold).fontColor('#FFFFFF');
        }
        .layoutWeight(1)
        .height(52)
        .borderRadius(14)
        .backgroundColor(C_ACCENT)
        .onClick(() => {
          this.currentStep = 2;
        });
      } else if (this.currentStep === 2) {
        Button({ type: ButtonType.Normal }) {
          Text(this.localizedText('onboarding_next', 'Next')).fontSize(16).fontWeight(FontWeight.Bold).fontColor('#FFFFFF');
        }
        .layoutWeight(1)
        .height(52)
        .borderRadius(14)
        .backgroundColor(C_ACCENT)
        .onClick(() => {
          this.handleGatewayNext();
        });
      } else if (this.currentStep === 3) {
        Button({ type: ButtonType.Normal }) {
          Text(this.localizedText('onboarding_next', 'Next')).fontSize(16).fontWeight(FontWeight.Bold).fontColor('#FFFFFF');
        }
        .layoutWeight(1)
        .height(52)
        .borderRadius(14)
        .backgroundColor(C_ACCENT)
        .onClick(() => {
          this.handlePermissionsNext();
        });
      } else if (this.connectedState) {
        Button({ type: ButtonType.Normal }) {
          Text(this.localizedText('onboarding_finish', 'Finish')).fontSize(16).fontWeight(FontWeight.Bold).fontColor('#FFFFFF');
        }
        .layoutWeight(1)
        .height(52)
        .borderRadius(14)
        .backgroundColor(C_SUCCESS)
        .onClick(() => {
          void this.viewModel.setOnboardingCompleted(true);
          this.onComplete();
        });
      } else {
        Button({ type: ButtonType.Normal }) {
          Text(this.isConnecting ? this.localizedText('onboarding_connecting', 'Connecting…') : this.localizedText('onboarding_connect', 'Connect'))
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor('#FFFFFF');
        }
        .layoutWeight(1)
        .height(52)
        .borderRadius(14)
        .backgroundColor(C_ACCENT)
        .enabled(!this.isConnecting)
        .onClick(() => {
          void this.attemptConnection();
        });
      }
    }
    .width('100%')
    .padding({ left: 20, right: 20, top: 12, bottom: 20 });
  }

  @Builder SectionHeader(title: string) {
    Column() {
      Divider().color(C_BORDER);
      Text(title)
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .fontColor(C_TEXT)
        .margin({ top: 14, bottom: 14 });
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  @Builder CommandBlock(command: string) {
    Row() {
      Row().width(3).height(42).backgroundColor(C_CMD_ACCENT);
      Text(command)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(C_CMD_TEXT)
        .padding({ left: 12, right: 12, top: 10, bottom: 10 });
    }
    .width('100%')
    .backgroundColor(C_CMD_BG)
    .borderRadius(12)
    .border({ width: 1, color: C_CMD_BORDER })
    .margin({ bottom: 8 });
  }

  @Builder Bullet(text: string) {
    Row() {
      Row().width(8).height(8).borderRadius(999).backgroundColor(C_ACCENT_SOFT).margin({ top: 7, right: 4 });
      Row().width(4).height(4).borderRadius(999).backgroundColor(C_ACCENT).margin({ top: 9, right: 8 });
      Text(text)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(C_TEXT_SEC)
        .layoutWeight(1)
        .lineHeight(22);
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({ bottom: 8 });
  }

  @Builder ModeChip(label: string, active: boolean, onClick: () => void) {
    Button({ type: ButtonType.Normal }) {
      Text(label).fontSize(13).fontWeight(FontWeight.Bold).fontColor(active ? '#FFFFFF' : C_TEXT);
    }
    .height(40)
    .borderRadius(12)
    .backgroundColor(active ? C_ACCENT : C_SURFACE)
    .border({ width: 1, color: active ? '#184DAF' : C_BORDER_STRONG })
    .padding({ left: 16, right: 16 })
    .margin({ right: 8 })
    .onClick(() => {
      onClick();
    });
  }

  @Builder QuickFillChip(label: string, onClick: () => void) {
    Button({ type: ButtonType.Normal }) {
      Text(label).fontSize(12).fontWeight(FontWeight.Bold).fontColor(C_ACCENT);
    }
    .height(32)
    .borderRadius(999)
    .backgroundColor(C_ACCENT_SOFT)
    .padding({ left: 12, right: 12 })
    .margin({ right: 8 })
    .onClick(() => {
      onClick();
    });
  }

  @Builder ResolvedEndpoint(endpoint: string) {
    Column() {
      Divider().color(C_BORDER);
      Text(this.localizedText('onboarding_resolved_endpoint', 'RESOLVED ENDPOINT'))
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor(C_TEXT_SEC)
        .letterSpacing(0.7)
        .margin({ top: 8, bottom: 4 });
      Text(endpoint)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(C_TEXT);
      Divider().color(C_BORDER).margin({ top: 8 });
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ top: 8, bottom: 8 });
  }

  @Builder SummaryField(label: string, value: string) {
    Column() {
      Text(label)
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor(C_TEXT_SEC)
        .letterSpacing(0.6)
        .margin({ bottom: 4 });
      Text(value)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(C_TEXT);
      Divider().color(C_BORDER).margin({ top: 8, bottom: 12 });
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start);
  }

  private handleGatewayNext(): void {
    if (this.inputMode === 'SetupCode') {
      const code = this.setupCode.trim();
      if (code.length === 0) {
        this.gatewayError = this.localizedText('onboarding_error_setup_code_first', 'Paste a setup code first, or switch to Manual setup.');
        return;
      }
    } else {
      const host = this.manualHost.trim();
      const parsedPort = parseInt(this.manualPort.trim(), 10);
      if (host.length === 0 || Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        this.gatewayError = this.localizedText('onboarding_error_valid_host_port', 'Please enter a valid host and port.');
        return;
      }
    }
    this.gatewayError = '';
    this.currentStep = 3;
  }

  private handlePermissionsNext(): void {
    void this.viewModel.setCameraEnabled(this.enableCamera);
    void this.viewModel.setLocationMode(this.enableLocation ? LocationMode.Approximate : LocationMode.Off);
    void this.viewModel.setMicEnabled(this.enableMicrophone);
    void this.viewModel.setSpeakerEnabled(this.enableNotifications);
    this.currentStep = 4;
  }

  private attemptConnection(): void {
    console.info('OnboardingPage: attemptConnection start, mode=' + this.inputMode);
    this.isConnecting = true;
    this.attemptedConnect = true;
    this.gatewayError = '';

    if (this.inputMode === 'SetupCode') {
      const code = this.setupCode.trim();
      console.info('OnboardingPage: setup code submit, length=' + code.length);
      if (code.length === 0) {
        console.warn('OnboardingPage: setup code missing');
        this.gatewayError = this.localizedText('onboarding_error_paste_valid_setup_code', 'Paste a valid setup code to connect.');
        this.isConnecting = false;
        return;
      }

      MainViewModel.connectFromSetupCodeTask(this.viewModel, code)
        .then((connected: boolean) => {
          console.info('OnboardingPage: setup code connect result=' + connected + ', status=' + this.viewModel.statusText);
          if (!connected) {
            this.gatewayError = this.viewModel.statusText || this.localizedText('onboarding_error_connect_setup_code_failed', 'Unable to connect with this setup code.');
            console.warn('OnboardingPage: setup code connection failed: ' + this.gatewayError);
          }
        })
        .catch((error: Error) => {
          console.error('OnboardingPage: attemptConnection error:', error);
          this.gatewayError = this.localizedText('onboarding_error_connection_retry', 'Connection error. Please try again.');
        })
        .finally(() => {
          console.info('OnboardingPage: attemptConnection end, connected=' + this.viewModel.isConnected + ', error=' + this.gatewayError);
          this.isConnecting = false;
        });
      return;
    }

    const host = this.manualHost.trim();
    const parsedPort = parseInt(this.manualPort.trim(), 10);
    console.info(
      'OnboardingPage: manual connect submit, host=' + host + ', port=' + parsedPort + ', tls=' + this.manualTls
    );
    if (host.length === 0 || Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      console.warn('OnboardingPage: invalid manual gateway input');
      this.gatewayError = this.localizedText('onboarding_error_enter_valid_manual_host_port', 'Enter a valid manual host and port.');
      this.isConnecting = false;
      return;
    }

    this.viewModel.manualEnabled = true;
    this.viewModel.manualHost = host;
    this.viewModel.manualPort = parsedPort;
    this.viewModel.manualTls = this.manualTls;
    this.viewModel.gatewayToken = this.gatewayToken.trim();
    this.viewModel.gatewayPassword = this.gatewayPassword.trim();

    MainViewModel.connectManualTask(this.viewModel)
      .then(() => {
        console.info('OnboardingPage: manual connect finished, connected=' + this.viewModel.isConnected + ', status=' + this.viewModel.statusText);

        if (!this.viewModel.isConnected) {
          this.gatewayError = this.viewModel.statusText || this.localizedText('onboarding_error_connection_failed_check_settings', 'Connection failed. Check your settings and try again.');
          console.warn('OnboardingPage: manual connection failed: ' + this.gatewayError);
        }
      })
      .catch((error: Error) => {
        console.error('OnboardingPage: attemptConnection error:', error);
        this.gatewayError = this.localizedText('onboarding_error_connection_retry', 'Connection error. Please try again.');
      })
      .finally(() => {
        console.info('OnboardingPage: attemptConnection end, connected=' + this.viewModel.isConnected + ', error=' + this.gatewayError);
        this.isConnecting = false;
      });
  }

  private gatewayStatusText(): string {
    if (this.connectedState) {
      return this.localizedText('chat_connected', 'Connected');
    }
    return this.statusState || this.localizedText('chat_offline', 'Offline');
  }

  private stepLabel(step: number): string {
    switch (step) {
      case 1:
        return this.localizedText('onboarding_step_welcome', 'Welcome');
      case 2:
        return this.localizedText('onboarding_step_gateway', 'Gateway');
      case 3:
        return this.localizedText('onboarding_step_permissions', 'Permissions');
      default:
        return this.localizedText('onboarding_step_connect', 'Connect');
    }
  }

  private localizedText(name: string, fallback: string): string {
    try {
      void this.localeVersion;
      return getContext(this).resourceManager.getStringByNameSync(name);
    } catch (error) {
      console.warn('OnboardingPage: localizedText failed for key: ' + name);
      return fallback;
    }
  }

  private currentStepText(): string {
    return this.localizedText('onboarding_step_counter', 'Step {current} of {total}')
      .replaceAll('{current}', String(this.currentStep))
      .replaceAll('{total}', String(this.totalSteps));
  }

  private statusLineText(): string {
    return this.localizedText('onboarding_status_value', 'Status: {value}')
      .replaceAll('{value}', this.gatewayStatusText());
  }

  private connectedToText(): string {
    const target = this.serverNameState || this.remoteAddressState || this.localizedText('onboarding_gateway_fallback', 'gateway');
    return this.localizedText('onboarding_connected_to', 'Connected to {target}')
      .replaceAll('{target}', target);
  }

  private syncConnectionState(): void {
    this.connectedState = this.viewModel.isConnected;
    this.statusState = this.viewModel.statusText || this.localizedText('chat_offline', 'Offline');
    this.serverNameState = this.viewModel.serverName || '';
    this.remoteAddressState = this.viewModel.remoteAddress || '';

    if (this.connectedState) {
      this.isConnecting = false;
      this.gatewayError = '';
    }
  }
}
