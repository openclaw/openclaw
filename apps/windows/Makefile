.PHONY: restore build test lint format package-x64 package-arm64 clean

restore:
	dotnet restore

build:
	dotnet build -c Release

test:
	dotnet test --logger "console;verbosity=normal"

test-coverage:
	dotnet test --collect:"XPlat Code Coverage" --results-directory coverage/

lint:
	dotnet format --verify-no-changes

format:
	dotnet format

package-x64:
	msbuild packaging/OpenClawWindows.wapproj /p:Platform=x64 /p:Configuration=Release /p:AppxBundle=Never

package-arm64:
	msbuild packaging/OpenClawWindows.wapproj /p:Platform=ARM64 /p:Configuration=Release /p:AppxBundle=Never

clean:
	dotnet clean
	rm -rf coverage/
