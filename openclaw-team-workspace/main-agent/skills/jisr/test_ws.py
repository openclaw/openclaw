import asyncio
import websockets
async def test():
    try:
        async with websockets.connect("ws://localhost:9000/ws/run-agent", user_agent_header="Mozilla/5.0") as ws:
            print("Connected without origin")
    except Exception as e:
        print("Error:", e)
asyncio.run(test())